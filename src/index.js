import {docopt} from 'docopt';
import fs from 'mz/fs';
import taskcluster from 'taskcluster-client';
import path from 'path';
import _ from 'lodash';
import yaml from 'js-yaml';
import 'source-map-support/register';
import * as openpgp from 'openpgp';

import {ProofBuilder, ProofError, dumpJSON} from './proofbuilder';
import * as rules from './rules';

// 458c900dd4ef310d5bffae1f2bb97da50839cc66 firefox.linux64-debug public/build/target.checksums

let docs = `Verify COT artifacts, and download verified artifacts.

Usage:
  verify-cot [options] [--] <revision> <task-id> [<artifact>...]

Options:
  -r, --repository <repository>  Repository [default: mozilla-central]
`;

let main = async (args) => {
  let opts = docopt(docs, {version: ''});
  let repository = opts['--repository'];
  let revision = opts['<revision>'];
  let artifacts = opts['<artifact>'] || [];
  let taskId = opts['<task-id>'];

  if (!/^[a-zA-Z0-9_-]{22}$/.test(taskId)) {
    let index = new taskcluster.Index();
    let result = await index.findTask(
      `gecko.v2.${repository}.revision.${revision}.${taskId}`,
    );
    taskId = result.taskId;
  }

  let keyFolder = './keys';
  let workerTypePublicKeys = _.reduce(await Promise.all(
    (await fs.readdir(keyFolder)).map(async (filename) => {
      try {
        let data = await fs.readFile(path.join(keyFolder, filename));
        if (/\.json$/.test(filename)) {
          data = JSON.parse(data);
        }
        if (/\.ya?ml$/.test(filename)) {
          data = yaml.safeLoad(data);
        }
        let keys = openpgp.key.readArmored(data.publicKey).keys || [];
        let result = {};
        for (let workerTypeId of data.authorizes) {
          result[workerTypeId] = keys;
        }
        return result;
      } catch (err) {
        console.log(`Failed to load key from ${filename}, error: `, err);
      }
    }),
  ), _.partialRight(_.assignInWith, _.union), {});

  let builder = new ProofBuilder({
    sourceExtractors:   rules.sourceExtractors,
    rules:              rules.minimal,
    workerTypePublicKeys,
  });
  try {
    let proof = await builder.task(taskId);
    if (_.isEqual(proof.source, {repository, revision})) {
      console.log('Proof');
      console.log(JSON.stringify(dumpJSON(proof), null, '  '));
      return 0;
    } else {
      console.log('Wrong source:');
      console.log(JSON.stringify(dumpJSON(proof), null, '  '));
    }
  } catch (err) {
    if (err instanceof ProofError) {
      console.log('ProfError');
      console.log(JSON.stringify(dumpJSON(err), null, '  '));
      return 1;
    }
    console.log('Error');
    console.log(err.stack);
  }
  return 1;
};

if (/*!module.parent*/true) {
  main(process.argv.slice(2)).catch(err => {
    console.error(err.stack);
    return 1;
  }).then(code => process.exit(code));
}
