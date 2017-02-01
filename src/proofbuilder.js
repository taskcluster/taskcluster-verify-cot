import _ from 'lodash';
import got from 'got';
import taskcluster from 'taskcluster-client';
import AJV from 'ajv';
import fs from 'fs';
import rootdir from 'app-root-dir';
import path from 'path';
import ExtendableError from 'es6-error';
import * as openpgp from 'openpgp';
import assert from 'assume';

const COT_ARTIFACT_NAME = 'public/chainOfTrust.json.asc';
const SOURCE_URL_TEMPLATE = _.template(
  'https://hg.mozilla.org/${repository}/raw-file/${revision}/${path}', {},
);

let validator = (() => {
  let ajv = new AJV();
  _.map([
    'task.json', 'cot.json',
  ], file => {
    let filepath = path.join(rootdir.get(), 'schemas', file);
    ajv.addSchema(JSON.parse(fs.readFileSync(filepath)));
  });
  let f = ajv.getSchema('http://schemas.taskcluster.net/common/v1/cot.json#');
  return (cot) => {
    if (!f(cot)) {
      return ajv.errorsText();
    }
    return null;
  };
})();

async function getCOTArtifact(taskId) {
  let queue = new taskcluster.Queue();
  let u = queue.buildUrl(queue.getLatestArtifact, taskId, COT_ARTIFACT_NAME);
  try {
    // TODO: Retry on network failures
    return (await got(u)).body;
  } catch (err) {
    throw new ProofError('Failed to fetch COT-artifact: [0]', [
      err.message,
    ]);
  }
}

export function ParseJSON(data) {
  try {
    return JSON.parse(data);
  } catch (err) {
    throw new ProofError('Expected [0] to be valid JSON, error: [1]', [
      data, err.message,
    ]);
  }
}

let crossMap = (A, B, func) => _.flatMap(A, a => _.map(B, b => func(a, b)));

// Types:
//   source: {repository, revision}
//   rule:   {name, conditions}
//   proof:  {source, cot, rule, reasons}
//   cot:    {/* JSON matching COT schema */}
//   reason: {text, refs}

export class Rule {
  constructor(name, conditions = []) {
    _.assign(this, {name, conditions});
  }
}

export class Reason {
  constructor(message, refs = []) {
    assert(message).is.string();
    _.assign(this, {message, refs});
  }
}

export class Proof {
  constructor(source, cot, rule, reasons) {
    _.assign(this, {source, cot, rule, reasons});
  }
}

export class ProofError extends ExtendableError {
  constructor(message, refs = []) {
    super(message);
    this.refs = refs;
    this.message = message;
    this.name = 'ProofError';
  }
}

let isProofError = err => err instanceof ProofError;

export function wrapProofError(message, refs = []) {
  return (err) => {
    if (err instanceof ProofError) {
      throw new ProofError(message, [err, ...refs]);
    }
    throw err;
  };
};

export function assume(value) {
  let assume = assert(value);
  assume.test = (passed, message, expectation) => {
    if (!passed) {
      throw new ProofError(`${message}, assumed ${expectation()}`);
    }
    return new Reason(`${message}, because ${expectation()}`);
  };
  return assume;
}

export function dumpJSON(obj) {
  return _.cloneDeepWith(obj, val => {
    if (isProofError(val)) {
      return {
        type:         'error',
        message:      val.message,
        refs:         dumpJSON(val.refs),
      };
    }
    if (val instanceof Reason) {
      return {
        type:         'reason',
        message:      val.message,
        refs:         dumpJSON(val.refs),
      };
    }
    if (val instanceof Rule) {
      return {
        type:         'rule',
        name:         val.name,
        conditions:   dumpJSON(val.conditions),
      };
    }
    if (val instanceof Function) {
      return val.name || null;
    }
  });
}

/** Call f ensuring exceptions are always asynchronous by wrapping in Promise */
let asyncCatch = (f, ...args) => new Promise(resolve => resolve(f(...args)));

export class ProofBuilder {
  constructor(options = {}) {
    _.defaults(this, options, {
      sourceExtractors:     [],
      rules:                [],
      workerTypePublicKeys: {},
    });
    this._cache = {};
    this._artifactCache = {};
    this._sourceCache = {};
  }

  async task(taskId, excludedTaskIds = []) {
    if (_.includes(excludedTaskIds, taskId)) {
      throw new ProofError(
        'Recursive task dependency attempted in [0], forbidden taskIds: [1]',
        [taskId, excludedTaskIds],
      );
    }
    return this._cache[taskId] || (this._cache[taskId] = (async () => {
      let signature = await getCOTArtifact(taskId);
      let message = openpgp.cleartext.readArmored(signature);
      let cot = ParseJSON(message.getText());
      let schemaError = validator(cot);
      if (schemaError) {
        throw new ProofError('COT-artifact [0] does not match schema', [
          cot, schemaError,
        ]);
      }

      let workerTypeId = `${cot.task.provisionerId}/${cot.task.workerType}`;
      let keys = this.workerTypePublicKeys[workerTypeId] || [];
      if (!message.verify(keys)[0].valid) {
        throw new ProofError(`COT-artifact for ${taskId} [0] not signed by ` +
                             'key matching workerType', [cot]);
      }

      let builder = new SubProofBuilder(this, [taskId, ...excludedTaskIds]);
      let sources = (await Promise.all(this.sourceExtractors.map(extractor => {
        return asyncCatch(extractor, builder, cot).catch(err => {
          if (isProofError(err)) {
            return null;
          }
          throw err;
        });
      }))).filter(_.negate(_.isNil));
      sources = _.uniqWith(sources, _.isEqual);

      let proofs = await Promise.all(crossMap(sources, this.rules, async (source, rule) => {
        let reasons = await Promise.all(rule.conditions.map(condition => {
          return asyncCatch(condition, builder, cot, source).catch(err => {
            if (isProofError(err)) {
              return err;
            }
            throw err;
          });
        }));
        if (!_.some(reasons, isProofError)) {
          return new Proof(source, cot, rule, reasons);
        }
        return new ProofError(`Conditions [1] failed for rule ${rule.name} [0]`, [
          rule, _.reduce(reasons, (summary, reason, index) => {
            if (isProofError(reason)) {
              summary[rule.conditions[index].name || index] = reason;
            }
            return summary;
          }, {}),
        ]);
      }));
      if (_.some(proofs, _.negate(isProofError))) {
        return _.head(_.filter(proofs, _.negate(isProofError)));
      }
      throw new ProofError(
        `No rules were satisifed for taskId: ${cot.taskId}, see [0] for ` +
        `sources detected and [1] for errors`, [sources, proofs],
      );
    })());
  }

  /** Get buffer */
  async artifact(taskId, name, excludedTaskIds = []) {
    let proof = await this.task(taskId, excludedTaskIds);
    let k = taskId + name;
    return this._artifactCache[k] || (this._artifactCache[k] = (async () => {
      // TODO: Download artifact and validate against hashsum from proof.cot
    })());
  }

  source(source, path) {
    let k = source.repository + '#' + source.revision + ':' + path;
    return this._sourceCache[k] || (this._sourceCache[k] = (async () => {
      let u = SOURCE_URL_TEMPLATE(_.defaults({}, source, {path}));
      try {
        console.log('Downloading!!');
        // TODO: Download from u with retries
        return (await got(u)).body;
      } catch (err) {
        throw new ProofError(
          `Failed to fetch source ${path} from [0], error: [1]`,
          [source, err.message],
        );
      }
    })());
  }
}

class SubProofBuilder extends ProofBuilder {
  constructor(parent, excluded) {
    super();
    this._parent = parent;
    this._excluded = excluded;
  }

  task(taskId) {
    return this._parent.task(taskId, this._excluded);
  }

  artifact(taskId, path) {
    return this._parent.artifact(taskId, path, this._excluded);
  }

  source(source, path) {
    return this._parent.source(source, path);
  }
}
