import fs from 'node:fs'
import path from 'node:path'

interface DirectoryOperations {
  exists: (directory: string) => boolean
  remove: (directory: string) => void
  rename: (source: string, destination: string) => void
}

interface ReplaceDirectoryOptions {
  targetDirectory: string
  stagingDirectory: string
  backupDirectory?: string
  validate: (directory: string) => void
  operations?: DirectoryOperations
}

interface FileOperations {
  exists: (file: string) => boolean
  remove: (file: string) => void
  rename: (source: string, destination: string) => void
  write: (file: string, contents: string) => void
}

const fileSystemOperations: DirectoryOperations = {
  exists: fs.existsSync,
  remove: (directory) => fs.rmSync(directory, { recursive: true, force: true }),
  rename: fs.renameSync,
}

const fileOperations: FileOperations = {
  exists: fs.existsSync,
  remove: (file) => fs.rmSync(file, { force: true }),
  rename: fs.renameSync,
  write: (file, contents) => fs.writeFileSync(file, contents, 'utf8'),
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function assertSiblingDirectories(target: string, staging: string, backup: string): void {
  const parent = path.dirname(target)
  const uniqueDirectories = new Set([target, staging, backup])
  if (uniqueDirectories.size !== 3 || path.dirname(staging) !== parent || path.dirname(backup) !== parent) {
    throw new Error('runtime directory replacement paths must be distinct siblings')
  }
}

function validateRuntimeVersion(version: string): string {
  const normalized = version.trim()
  if (
    !normalized
    || normalized.length > 128
    || normalized === '.'
    || normalized === '..'
    || !/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/.test(normalized)
  ) {
    throw new Error(`unsafe runtime version: ${version}`)
  }
  return normalized
}

function resolveRuntimeVersionDirectory(runtimeBaseDirectory: string, version: string): string {
  const base = path.resolve(runtimeBaseDirectory)
  const target = path.resolve(base, validateRuntimeVersion(version))
  const relative = path.relative(base, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`runtime version directory escapes its base: ${version}`)
  }
  return target
}

function replaceDirectoryAtomically({
  targetDirectory,
  stagingDirectory,
  backupDirectory = `${targetDirectory}.backup`,
  validate,
  operations = fileSystemOperations,
}: ReplaceDirectoryOptions): void {
  const target = path.resolve(targetDirectory)
  const staging = path.resolve(stagingDirectory)
  const backup = path.resolve(backupDirectory)
  assertSiblingDirectories(target, staging, backup)
  if (!operations.exists(staging)) throw new Error(`runtime staging directory does not exist: ${staging}`)

  let targetBackedUp = false
  let stagingPromoted = false
  try {
    validate(staging)

    if (operations.exists(backup)) {
      if (operations.exists(target)) {
        let targetIsValid = true
        try {
          validate(target)
        } catch {
          targetIsValid = false
        }
        if (targetIsValid) {
          operations.remove(backup)
        } else {
          operations.remove(target)
          operations.rename(backup, target)
        }
      } else {
        operations.rename(backup, target)
      }
    }

    if (operations.exists(target)) {
      operations.rename(target, backup)
      targetBackedUp = true
    }

    operations.rename(staging, target)
    stagingPromoted = true
    validate(target)

    if (targetBackedUp && operations.exists(backup)) {
      try {
        operations.remove(backup)
      } catch {
        // The promoted runtime is valid. Keep the old backup for a later cleanup attempt.
      }
    }
  } catch (error) {
    const rollbackErrors: unknown[] = []

    if (stagingPromoted && operations.exists(target)) {
      try {
        operations.remove(target)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (targetBackedUp && operations.exists(backup)) {
      try {
        operations.rename(backup, target)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (operations.exists(staging)) {
      try {
        operations.remove(staging)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }

    if (rollbackErrors.length) {
      throw new Error(
        `runtime directory replacement failed: ${errorMessage(error)}; rollback failed: ${rollbackErrors.map(errorMessage).join('; ')}`,
        { cause: error },
      )
    }
    throw error
  }
}

function writeFileAtomically(
  targetFile: string,
  contents: string,
  operations: FileOperations = fileOperations,
): void {
  const target = path.resolve(targetFile)
  const temporary = `${target}.${process.pid}-${Date.now()}.tmp`

  try {
    operations.write(temporary, contents)
    operations.rename(temporary, target)
  } finally {
    if (operations.exists(temporary)) operations.remove(temporary)
  }
}

export {
  replaceDirectoryAtomically,
  resolveRuntimeVersionDirectory,
  validateRuntimeVersion,
  writeFileAtomically,
}
export type { DirectoryOperations, FileOperations, ReplaceDirectoryOptions }
