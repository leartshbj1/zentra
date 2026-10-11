import { lstatSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  resolve,
  sep,
} from 'node:path';

// Test-only. Importing this module neither loads pg nor opens a connection.
// A separate fresh loopback database is required; ambient libpq settings cannot
// silently select an existing database or a remote production destination.
const PREFIX = 'ZENTRA_ACTION_REAL_PG';
const failure = () => {
  throw new Error('ZENTRA_ACTION_REAL_PG_CONFIGURATION_REFUSED');
};
function required(environment, suffix) {
  const value = environment[`${PREFIX}_${suffix}`];
  if (typeof value !== 'string' || !value || value.trim() !== value) failure();
  return value;
}
function ordinaryPath(input, directory) {
  if (
    !isAbsolute(input) ||
    input.length > 1024 ||
    /(?:^|[\\/])\.\.?([\\/]|$)/.test(input)
  )
    failure();
  const path = resolve(input);
  const root = parse(path).root;
  let cursor = root;
  for (const part of path.slice(root.length).split(sep)) {
    if (!part) continue;
    cursor = join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) failure();
  }
  const stat = lstatSync(path);
  if (directory ? !stat.isDirectory() : !stat.isFile()) failure();
  return realpathSync(path);
}

export function readRealPostgresConfiguration(environment = process.env) {
  try {
    if (
      environment[PREFIX] !== '1' ||
      Object.keys(environment).some((key) => /^PG[A-Z_]*$/i.test(key))
    )
      failure();
    const host = required(environment, 'HOST');
    const portLiteral = required(environment, 'PORT');
    const runId = required(environment, 'RUN_ID');
    const database = required(environment, 'DATABASE');
    const user = required(environment, 'USER');
    const sourceCommit = required(environment, 'SOURCE_COMMIT');
    if (
      host !== '127.0.0.1' ||
      !/^[1-9][0-9]{3,4}$/.test(portLiteral) ||
      Number(portLiteral) < 1024 ||
      Number(portLiteral) > 65535 ||
      !/^[a-f0-9]{32}$/.test(runId) ||
      database !== `zentra_action_engine_qa_${runId}` ||
      user !== database ||
      !/^[a-f0-9]{40}$/.test(sourceCommit)
    )
      failure();
    const password = environment[`${PREFIX}_PASSWORD`] ?? '';
    if (
      typeof password !== 'string' ||
      password.length > 256 ||
      ['\0', '\r', '\n'].some((character) => password.includes(character))
    )
      failure();
    const moduleDirectory = ordinaryPath(
      required(environment, 'MODULE_DIR'),
      true,
    );
    const packageFile = ordinaryPath(
      join(moduleDirectory, 'package.json'),
      false,
    );
    if (lstatSync(packageFile).size > 65536) failure();
    const packageJson = JSON.parse(readFileSync(packageFile, 'utf8'));
    if (
      packageJson.name !== 'pg' ||
      typeof packageJson.version !== 'string' ||
      !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(packageJson.version)
    )
      failure();
    const requestedReport = required(environment, 'REPORT_FILE');
    if (
      !isAbsolute(requestedReport) ||
      requestedReport.length > 1024 ||
      /(?:^|[\\/])\.\.?([\\/]|$)/.test(requestedReport) ||
      basename(requestedReport) !==
        `action-engine-real-postgres-${runId}.json` ||
      existsSync(requestedReport)
    )
      failure();
    const reportDirectory = ordinaryPath(dirname(requestedReport), true);
    const reportFile = join(reportDirectory, basename(requestedReport));
    return Object.freeze({
      host,
      port: Number(portLiteral),
      runId,
      database,
      user,
      password,
      sourceCommit,
      moduleDirectory,
      moduleVersion: packageJson.version,
      reportFile,
    });
  } catch {
    // Never echo an environment value, path, password or a driver's error.
    failure();
  }
}
