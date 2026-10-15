'use strict';

// Audit-only tee for the exact stdout bytes received by Electron from the
// VideoAutoCut engine. The original ChildProcess streams are left untouched.
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const moduleBuiltin = require('node:module');
const path = require('node:path');

const outputRoot = process.env.VACUT_STDOUT_CAPTURE_ROOT;
const expectedOwner = (process.env.VACUT_CAPTURE_OWNER_BASENAME || 'electron.exe').toLowerCase();
const expectedChild = (process.env.VACUT_CAPTURE_COMMAND_BASENAME || 'videoautocutengine.exe').toLowerCase();
const actualOwner = path.basename(process.execPath).toLowerCase();
const electronProcessType = process.versions.electron ? String(process.type || '') : null;
const ownerIsEligible = actualOwner === expectedOwner && (!process.versions.electron || electronProcessType === 'browser');

if (outputRoot && ownerIsEligible) {
  fs.mkdirSync(outputRoot, { recursive: true });
  const activationPath = path.join(outputRoot, `activation-owner-${process.pid}.json`);
  const moduleSha256 = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
  const originalSpawn = childProcess.spawn;
  let sequence = 0;

  childProcess.spawn = function auditedSpawn(command, args, options) {
    const commandBase = path.basename(String(command)).toLowerCase();
    const commandPath = commandBase === expectedChild ? fs.realpathSync(String(command)) : null;
    const commandSha256 = commandPath
      ? crypto.createHash('sha256').update(fs.readFileSync(commandPath)).digest('hex')
      : null;
    const child = originalSpawn.apply(this, arguments);
    if (commandBase !== expectedChild || !child.stdout) return child;

    const seq = ++sequence;
    const childPid = child.pid || 0;
    const prefix = `observer-${process.pid}-seq-${seq}-child-${childPid}`;
    const stdoutPath = path.join(outputRoot, `${prefix}-stdout.bin`);
    const stderrPath = path.join(outputRoot, `${prefix}-stderr.bin`);
    const eventsPath = path.join(outputRoot, `${prefix}-vacut-events.bin`);
    const metadataPath = path.join(outputRoot, `${prefix}-metadata.json`);
    const stdoutFd = fs.openSync(stdoutPath, 'wx');
    const stderrFd = fs.openSync(stderrPath, 'wx');
    const eventsFd = fs.openSync(eventsPath, 'wx');
    const stdoutHash = crypto.createHash('sha256');
    const stderrHash = crypto.createHash('sha256');
    const eventHash = crypto.createHash('sha256');
    const argvHash = crypto.createHash('sha256').update(JSON.stringify(args || [])).digest('hex');
    const startedAt = new Date().toISOString();
    const spawnPath = path.join(outputRoot, `${prefix}-spawn.json`);
    fs.writeFileSync(spawnPath, `${JSON.stringify({
      schema: 'vacut-engine-spawn-identity/v1',
      recorded_at: startedAt,
      observer_pid: process.pid,
      child_pid: childPid,
      requested_executable_path: commandPath,
      child_spawnfile: child.spawnfile ? String(child.spawnfile) : null,
      executable_sha256_at_spawn: commandSha256,
      arguments_sha256: argvHash,
    }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutChunks = 0;
    let stderrChunks = 0;
    let eventBytes = 0;
    let eventLines = 0;
    let pending = Buffer.alloc(0);
    let closed = false;

    function observeLine(line) {
      let end = line.length;
      if (end && line[end - 1] === 0x0a) end -= 1;
      if (end && line[end - 1] === 0x0d) end -= 1;
      const body = line.subarray(0, end);
      const marker = Buffer.from('VACUT_EVENT:', 'ascii');
      if (body.length >= marker.length && body.subarray(0, marker.length).equals(marker)) {
        fs.writeSync(eventsFd, line);
        eventHash.update(line);
        eventBytes += line.length;
        eventLines += 1;
      }
    }

    child.stdout.on('data', (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      fs.writeSync(stdoutFd, bytes);
      stdoutHash.update(bytes);
      stdoutBytes += bytes.length;
      stdoutChunks += 1;
      pending = pending.length ? Buffer.concat([pending, bytes]) : Buffer.from(bytes);
      for (;;) {
        const newline = pending.indexOf(0x0a);
        if (newline < 0) break;
        observeLine(pending.subarray(0, newline + 1));
        pending = pending.subarray(newline + 1);
      }
    });

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        fs.writeSync(stderrFd, bytes);
        stderrHash.update(bytes);
        stderrBytes += bytes.length;
        stderrChunks += 1;
      });
    }

    child.once('close', (code, signal) => {
      if (closed) return;
      closed = true;
      if (pending.length) observeLine(pending);
      fs.closeSync(stdoutFd);
      fs.closeSync(stderrFd);
      fs.closeSync(eventsFd);
      const receipt = {
        schema: 'vacut-electron-stdout-tap/v1',
        observer_pid: process.pid,
        observer_executable_basename: actualOwner,
        child_pid: childPid,
        child_executable_basename: commandBase,
        child_executable_path: commandPath,
        child_executable_sha256_at_spawn: commandSha256,
        child_argv_sha256: argvHash,
        started_at: startedAt,
        closed_at: new Date().toISOString(),
        exit_code: code,
        signal: signal || null,
        stdout: {
          path: path.basename(stdoutPath),
          bytes: stdoutBytes,
          chunks: stdoutChunks,
          sha256: stdoutHash.digest('hex'),
        },
        stderr: {
          path: path.basename(stderrPath),
          bytes: stderrBytes,
          chunks: stderrChunks,
          sha256: stderrHash.digest('hex'),
        },
        vacut_events: {
          path: path.basename(eventsPath),
          lines: eventLines,
          bytes: eventBytes,
          sha256: eventHash.digest('hex'),
        },
      };
      fs.writeFileSync(metadataPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    });

    return child;
  };
  moduleBuiltin.syncBuiltinESMExports();

  fs.writeFileSync(activationPath, `${JSON.stringify({
    schema: 'vacut-electron-stdout-tap-activation/v1',
    activated_at: new Date().toISOString(),
    owner_pid: process.pid,
    owner_executable_basename: actualOwner,
    electron_process_type: electronProcessType,
    observer_module_basename: path.basename(__filename),
    observer_module_sha256: moduleSha256,
    child_filter_basename: expectedChild,
    builtin_spawn_patched: childProcess.spawn !== originalSpawn,
  }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });

  // Optional zero-import launch check. It exercises the ESM named export used
  // by process-runner.ts and records whether it is the patched function before
  // launching the real engine with --help.
  const preflightEnginePath = process.env.VACUT_CAPTURE_PREFLIGHT_ENGINE_PATH;
  if (preflightEnginePath) {
    void import('node:child_process').then(({ spawn }) => {
      const bindingMatches = spawn === childProcess.spawn;
      const child = spawn(preflightEnginePath, ['--help'], { windowsHide: true });
      child.once('close', (code, signal) => {
        const preflightPath = path.join(outputRoot, `preflight-owner-${process.pid}.json`);
        fs.writeFileSync(preflightPath, `${JSON.stringify({
          schema: 'vacut-electron-stdout-tap-preflight/v1',
          completed_at: new Date().toISOString(),
          owner_pid: process.pid,
          owner_executable_basename: actualOwner,
          esm_builtin_spawn_matches_patched_spawn: bindingMatches,
          child_executable_basename: path.basename(preflightEnginePath).toLowerCase(),
          child_executable_path: fs.realpathSync(preflightEnginePath),
          child_executable_sha256_at_spawn: crypto.createHash('sha256').update(fs.readFileSync(preflightEnginePath)).digest('hex'),
          child_arguments_sha256: crypto.createHash('sha256').update(JSON.stringify(['--help'])).digest('hex'),
          exit_code: code,
          signal: signal || null,
          import_or_model_invocation: false,
        }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      });
    }).catch((error) => {
      const failurePath = path.join(outputRoot, `preflight-owner-${process.pid}-failure.json`);
      fs.writeFileSync(failurePath, `${JSON.stringify({
        schema: 'vacut-electron-stdout-tap-preflight/v1',
        completed_at: new Date().toISOString(),
        owner_pid: process.pid,
        owner_executable_basename: actualOwner,
        status: 'failed-before-spawn',
        error_name: error && error.name ? String(error.name) : 'Error',
      }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    });
  }
}
