// Pure YAML contracts: only read files and the recorded Git baseline. Never run
// a CI recipe, PowerShell, Cargo, a native harness, an application or a provider.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baselineRevision = 'e2009dbf1f8def60ef8bb9c688eb4834f169c854';
const oldWorkflowName = 'action-engine-native-verification';
const newWorkflowName = 'action-native-profile-verification';
const newJobName = 'windows-action-native-profile-tests';
const reservedBranch = 'codex/action-engine-native';
const optIn = '<< pipeline.parameters.verify-native-profile-only >>';
const counts = { structuralChecks: 0, evaluatorChecks: 0, parameterCases: 0, historicalWorkflowComparisons: 0, g0EnabledCases: 0, nativeProfileEnabledCases: 0 };

function check(name, actual, expected) {
  assert.deepStrictEqual(actual, expected, name);
  counts.structuralChecks++;
}

function loadYaml() {
  const require = createRequire(import.meta.url);
  try {
    return require('js-yaml');
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    // pnpm may retain a transitive dependency without a root-level link. Read
    // its installed package directly; never install or fetch a dependency.
    const packages = path.join(repository, 'node_modules/.pnpm');
    const candidates = readdirSync(packages).filter(name => name === 'js-yaml@4.3.2');
    assert.equal(candidates.length, 1, 'the reviewed installed js-yaml package is required');
    return require(path.join(packages, candidates[0], 'node_modules/js-yaml/index.js'));
  }
}

function resolveValue(value, context) {
  if (typeof value !== 'string') {
    assert.ok(typeof value === 'boolean' || typeof value === 'number', 'only scalar condition operands are supported');
    return value;
  }
  if (!value.includes('<<') && !value.includes('>>')) return value;
  if (value === '<< pipeline.git.branch >>') return context.branch;
  const match = /^<< pipeline\.parameters\.([a-z][a-z0-9-]*) >>$/.exec(value);
  assert.ok(match && Object.hasOwn(context.parameters, match[1]), `unknown condition interpolation: ${value}`);
  return context.parameters[match[1]];
}

function evaluate(condition, context) {
  if (typeof condition === 'boolean' || typeof condition === 'string') {
    const value = resolveValue(condition, context);
    assert.equal(typeof value, 'boolean', 'conditions cannot use truthy strings or numbers');
    return value;
  }
  assert.ok(condition && !Array.isArray(condition) && typeof condition === 'object', 'condition must be a supported mapping');
  const operators = Object.keys(condition);
  assert.equal(operators.length, 1, 'condition has exactly one operator');
  const operator = operators[0];
  const operands = condition[operator];
  if (operator === 'not') return !evaluate(operands, context);
  if (operator === 'equal') {
    assert.ok(Array.isArray(operands) && operands.length === 2, 'equality requires exactly two operands');
    return Object.is(resolveValue(operands[0], context), resolveValue(operands[1], context));
  }
  assert.ok(operator === 'and' || operator === 'or', `unsupported condition operator: ${operator}`);
  assert.ok(Array.isArray(operands) && operands.length > 0, 'logical operators require a nonempty list');
  // Evaluate every operand so an unknown expression cannot hide behind a
  // short-circuit branch in this exhaustive source-only check.
  const values = operands.map(operand => evaluate(operand, context));
  return operator === 'and' ? values.every(Boolean) : values.some(Boolean);
}

function verifyEvaluator() {
  const context = { branch: reservedBranch, parameters: { enabled: true, disabled: false, zero: 0 } };
  for (const [condition, expected] of [
    [true, true], [false, false], [{ not: true }, false], [{ not: false }, true],
    [{ and: [true, false] }, false], [{ and: [true, true] }, true],
    [{ or: [false, true] }, true], [{ or: [false, false] }, false],
    [{ equal: [0, 0] }, true], [{ equal: [0, false] }, false],
    [{ equal: ['0', 0] }, false], [{ equal: ['A', 'a'] }, false],
    [{ equal: [reservedBranch, '<< pipeline.git.branch >>'] }, true],
    ['<< pipeline.parameters.enabled >>', true], ['<< pipeline.parameters.disabled >>', false],
    [{ and: ['<< pipeline.parameters.enabled >>', { not: '<< pipeline.parameters.disabled >>' }] }, true],
  ]) {
    assert.equal(evaluate(condition, context), expected);
    counts.evaluatorChecks++;
  }
  for (const invalid of [null, 1, [], {}, { unknown: true }, { and: [] }, { equal: [1] }, { not: true, and: [true] },
    'true', '<< pipeline.parameters.missing >>', { and: [false, { unknown: true }] }]) {
    assert.throws(() => evaluate(invalid, context));
    counts.evaluatorChecks++;
  }
}

function jobName(invocation) {
  if (typeof invocation === 'string') return invocation;
  assert.ok(invocation && typeof invocation === 'object' && !Array.isArray(invocation));
  assert.equal(Object.keys(invocation).length, 1, 'job invocation must have one job name');
  return Object.keys(invocation)[0];
}

function branchLiterals(workflows) {
  const branches = new Set();
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, 'equal')) {
      const operands = value.equal;
      for (let index = 0; index < 2; index++) {
        if (operands[index] === '<< pipeline.git.branch >>') {
          assert.equal(typeof operands[1 - index], 'string');
          assert.ok(!operands[1 - index].includes('<<'), 'branch equality uses a literal');
          branches.add(operands[1 - index]);
        }
      }
    }
    for (const nested of Object.values(value)) visit(nested);
  }
  for (const workflow of Object.values(workflows)) visit(workflow.when);
  return [...branches].sort();
}

function outputPath(arguments_) {
  if (arguments_.length === 0) return null;
  assert.ok(arguments_.length === 2 && arguments_[0] === '--output' && arguments_[1].length > 0, 'usage: node action-native-profile-workflow.tests.mjs [--output report.json]');
  const target = path.resolve(arguments_[1]);
  const relative = path.relative(repository, target);
  const inside = relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  const artifact = relative.startsWith(`.qa${path.sep}`) || relative.startsWith(`desktop${path.sep}artifacts${path.sep}`);
  assert.ok(!inside || artifact, '--output must be outside repository sources (or under .qa/ or desktop/artifacts/)');
  assert.equal(path.extname(target), '.json', '--output must name a JSON artifact');
  return target;
}

function main() {
  const reportPath = outputPath(process.argv.slice(2));
  const yaml = loadYaml();
  const currentText = readFileSync(path.join(repository, '.circleci/config.yml'), 'utf8');
  const baselineText = execFileSync('git', ['-C', repository, 'show', `${baselineRevision}:.circleci/config.yml`], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  // js-yaml rejects duplicate mapping keys by default. No YAML command or
  // interpolation is evaluated, and no CI tooling is invoked.
  const current = yaml.load(currentText);
  const baseline = yaml.load(baselineText);
  for (const section of ['parameters', 'jobs', 'workflows']) {
    assert.ok(current[section] && baseline[section], `both YAML files contain ${section}`);
  }
  const baselineOther = Object.fromEntries(Object.entries(baseline).filter(([name]) => !['parameters', 'jobs', 'workflows'].includes(name)));
  const currentOther = Object.fromEntries(Object.entries(current).filter(([name]) => !['parameters', 'jobs', 'workflows'].includes(name)));
  check('other top-level configuration is unchanged', currentOther, baselineOther);
  check('the only new parameter defaults to false', current.parameters, { ...baseline.parameters, 'verify-native-profile-only': { type: 'boolean', default: false } });

  const baselineJobs = Object.keys(baseline.jobs);
  check('exactly one new job is added', Object.keys(current.jobs).filter(name => !baselineJobs.includes(name)), [newJobName]);
  check('historical job order is unchanged', Object.keys(current.jobs).filter(name => name !== newJobName), baselineJobs);
  for (const name of baselineJobs) check(`historical job ${name} is unchanged`, current.jobs[name], baseline.jobs[name]);
  const expectedNewJob = {
    parallelism: 3,
    resource_class: 'windows.medium',
    machine: { image: 'windows-server-2022-gui:2026.05.1', shell: 'powershell.exe -NoProfile -ExecutionPolicy Bypass' },
    environment: {
      RUSTUP_TOOLCHAIN: 'stable-x86_64-pc-windows-msvc', CARGO_PROFILE_TEST_DEBUG: '0',
      ZENTRA_VERIFY_DIAGNOSTICS_ONLY: 'true', ZENTRA_VERIFY_ONLY: 'true',
      ZENTRA_VERIFY_NATIVE_PROFILE_ONLY: optIn,
      ZENTRA_NATIVE_PROFILE_RELEASE: '<< pipeline.parameters.release >>',
      ZENTRA_DIAGNOSTICS_NATIVE_SET: '<< pipeline.parameters.diagnostics-native-set >>',
      ZENTRA_NATIVE_PROFILE_PIPELINE_ID: '<< pipeline.id >>',
    },
    steps: ['checkout', { run: {
      name: 'Verify one compile-time native profile per isolated node',
      command: 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File desktop/scripts/verify-action-native-profile-windows.ps1',
      no_output_timeout: '20m',
    } }, { store_artifacts: { path: 'desktop/artifacts/action-native-profile', destination: 'action-native-profile-validation' } }],
  };
  check('the new job uses only its standalone recipe and distinct artifacts', current.jobs[newJobName], expectedNewJob);
  for (const name of baselineJobs) {
    for (const step of baseline.jobs[name].steps ?? []) {
      if (step?.store_artifacts) {
        assert.notEqual(step.store_artifacts.path, expectedNewJob.steps[2].store_artifacts.path, `${name} artifact path stays separate`);
        assert.notEqual(step.store_artifacts.destination, expectedNewJob.steps[2].store_artifacts.destination, `${name} artifact destination stays separate`);
      }
    }
  }

  const historicalNames = Object.keys(baseline.workflows).filter(name => name !== oldWorkflowName);
  check('baseline has the 53 historical workflows plus G0', [historicalNames.length, Object.keys(baseline.workflows).length], [53, 54]);
  check('exactly one new workflow is added', Object.keys(current.workflows).filter(name => !Object.hasOwn(baseline.workflows, name)), [newWorkflowName]);
  check('historical workflow order is unchanged', Object.keys(current.workflows).filter(name => name !== newWorkflowName), Object.keys(baseline.workflows));
  for (const name of historicalNames) check(`historical workflow ${name} is unchanged`, current.workflows[name], baseline.workflows[name]);
  const expectedG0 = structuredClone(baseline.workflows[oldWorkflowName]);
  expectedG0.when.and.splice(2, 0, { not: optIn });
  check('G0 changes only by excluding the new boolean', current.workflows[oldWorkflowName], expectedG0);
  check('new workflow has only the strict dedicated admission and standalone job', current.workflows[newWorkflowName], {
    when: { and: [
      { equal: [reservedBranch, '<< pipeline.git.branch >>'] }, '<< pipeline.parameters.verify-only >>', optIn,
      { not: '<< pipeline.parameters.release >>' },
      { equal: ['action-engine', '<< pipeline.parameters.diagnostics-native-set >>'] },
      { equal: [0, '<< pipeline.parameters.smoke-windows-job >>'] },
      { equal: [0, '<< pipeline.parameters.smoke-apple-job >>'] },
    ] }, jobs: [newJobName],
  });
  const newJobCallers = Object.entries(current.workflows).filter(([, workflow]) => workflow.jobs.some(invocation => jobName(invocation) === newJobName)).map(([name]) => name);
  check('only the new workflow invokes the new job', newJobCallers, [newWorkflowName]);
  check('branch predicates introduce no new literal branch', branchLiterals(current.workflows), branchLiterals(baseline.workflows));
  verifyEvaluator();

  const branches = [...branchLiterals(baseline.workflows), 'main', '', 'codex/native-profile-unrelated-branch', 'CODEX/action-engine-native', `refs/heads/${reservedBranch}`];
  check('branch representatives are distinct', new Set(branches).size, branches.length);
  const selectors = baseline.parameters['diagnostics-native-set'].enum;
  const platforms = baseline.parameters.platform.enum;
  check('all five selector values are covered', selectors, ['full', 'native-mail-payroll', 'benchmark-payment', 'benchmark-public-payment', 'action-engine']);
  check('all four platform values are covered', platforms, ['all', 'windows', 'apple', 'android']);
  for (const branch of branches) for (const selector of selectors) for (const release of [false, true])
    for (const verify of [false, true]) for (const nativeProfile of [false, true])
      for (const smokeWindows of [0, 1]) for (const smokeApple of [0, 1]) for (const platform of platforms) {
        const context = { branch, parameters: {
          'diagnostics-native-set': selector, release, 'verify-only': verify, 'verify-native-profile-only': nativeProfile,
          'smoke-windows-job': smokeWindows, 'smoke-apple-job': smokeApple, platform,
        } };
        const before = Object.keys(baseline.workflows).filter(name => evaluate(baseline.workflows[name].when, context));
        const after = Object.keys(current.workflows).filter(name => evaluate(current.workflows[name].when, context));
        const eligible = branch === reservedBranch && selector === 'action-engine' && !release && verify && smokeWindows === 0 && smokeApple === 0;
        const expected = before.filter(name => name !== oldWorkflowName || !nativeProfile);
        if (eligible && nativeProfile) expected.unshift(newWorkflowName);
        assert.deepStrictEqual(after, expected, `workflow selection changed for ${JSON.stringify(context)}`);
        assert.equal(after.includes(oldWorkflowName), eligible && !nativeProfile, 'G0 has exactly its ordinary opt-in admission');
        assert.equal(after.includes(newWorkflowName), eligible && nativeProfile, 'native-profile has exactly its additional opt-in admission');
        for (const name of historicalNames) assert.equal(after.includes(name), before.includes(name), `historical selection changed: ${name}`);
        if (branch === reservedBranch) assert.deepStrictEqual(after, eligible ? [nativeProfile ? newWorkflowName : oldWorkflowName] : [], 'reserved branch cannot dispatch packaging, smoke or a second workflow');
        counts.parameterCases++;
        counts.historicalWorkflowComparisons += historicalNames.length;
        if (after.includes(oldWorkflowName)) counts.g0EnabledCases++;
        if (after.includes(newWorkflowName)) counts.nativeProfileEnabledCases++;
      }
  check('exhaustive Cartesian product is complete', counts.parameterCases, branches.length * 5 * 2 ** 5 * 4);
  check('each isolated workflow admits only the four platform variants', [counts.g0EnabledCases, counts.nativeProfileEnabledCases], [4, 4]);
  const report = {
    kind: 'action-native-profile-workflow-source-contracts', passed: true,
    baselineRevision, currentYamlSha256: createHash('sha256').update(currentText).digest('hex'),
    nativeExecution: false, ciValidation: false, networkExecuted: false,
    baselineJobs: baselineJobs.length, unchangedHistoricalWorkflows: historicalNames.length,
    baselineWorkflows: Object.keys(baseline.workflows).length, currentWorkflows: Object.keys(current.workflows).length,
    dimensions: { branches: branches.length, branchValues: branches, selectors: 5, release: 2, verifyOnly: 2, verifyNativeProfileOnly: 2, smokeWindows: 2, smokeApple: 2, platforms: 4 },
    counts,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (reportPath) {
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, serialized, 'utf8');
  }
  process.stdout.write(serialized);
}

try {
  main();
} catch (error) {
  process.stdout.write(`${JSON.stringify({ kind: 'action-native-profile-workflow-source-contracts', passed: false, nativeExecution: false, ciValidation: false, networkExecuted: false, counts, error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
}
