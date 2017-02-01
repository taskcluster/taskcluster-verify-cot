import _ from 'lodash';
import yaml from 'js-yaml';
import taskcluster from 'taskcluster-client';
import mustache from 'mustache';

import {Rule, ProofError, Reason, wrapProofError, assume} from './proofbuilder';

export const sourceExtractors = [
  // source extractors on the form:
  //   async (builder, cot) => null || {repository, revision},
  detect_source_from_environment_variables,
  detect_source_from_decision_task,
];

export const minimal = [
  new Rule('DecisionTask', [
    taskId_equals_taskGroupId,
    match_source_decision_task_template,
    () => assume(false).is.true('rejecting'),
  ]),
  /*new Rule('DockerWorkerTask', [
    taskId_equals_taskGroupId,
  ]),*/
];

async function detect_source_from_environment_variables(builder, cot) {
  let env = cot.task.payload.env || {};
  let match = /^https:\/\/hg.mozilla.org\/([^\/]+)\/?$/.exec(
    env.GECKO_HEAD_REPOSITORY || '',
  );
  if (match && _.isString(env.GECKO_HEAD_REV)) {
    return {
      repository: match[1],
      revision:   env.GECKO_HEAD_REV,
    };
  }
}

async function detect_source_from_decision_task(builder, cot) {
  let decisionTaskProof = await builder.task(cot.task.taskGroupId);
  return decisionTaskProof.source;
}

async function taskId_equals_taskGroupId(builder, cot, source) {
  return assume(cot.taskId).equals(cot.task.taskGroupId, 'taskId must match task.taskGroupId');
}

async function match_source_decision_task_template(builder, cot, source) {
  let template = (await builder.source(source, '.taskcluster.yml')).toString();
  let {version, tasks} = yaml.safeLoad(mustache.render(template, {

  }));
  assume(version).equals(0, 'Expected template to have version 1');
}
