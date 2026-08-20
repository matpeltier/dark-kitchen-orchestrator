import { controlArgument, defineProcess, executeProcess } from '@dark-kitchen/process-execution';

export interface VerificationEnvironmentCommand {
  readonly executable: string;
  readonly args?: readonly string[] | undefined;
  readonly timeoutSeconds?: number | undefined;
}

export interface VerificationEnvironmentConfig {
  readonly setup?: readonly VerificationEnvironmentCommand[];
  readonly healthcheck?: readonly VerificationEnvironmentCommand[];
  readonly teardown?: readonly VerificationEnvironmentCommand[];
  readonly defaultCommandTimeoutMs?: number;
}

export interface VerificationEnvironmentCommandResult {
  readonly phase: 'setup' | 'healthcheck' | 'teardown';
  readonly index: number;
  readonly executable: string;
  readonly exitCode: number | null;
}

export class VerificationEnvironmentCommandError extends Error {
  public readonly phase: VerificationEnvironmentCommandResult['phase'];
  public readonly index: number;
  public readonly executable: string;
  public readonly exitCode: number | null;

  public constructor(result: VerificationEnvironmentCommandResult) {
    super(
      `Verification environment ${result.phase} command ${String(result.index + 1)} ` +
        `(${result.executable}) exited with code ${String(result.exitCode)}`,
    );
    this.name = 'VerificationEnvironmentCommandError';
    this.phase = result.phase;
    this.index = result.index;
    this.executable = result.executable;
    this.exitCode = result.exitCode;
  }
}

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

/**
 * Lazily prepares a verifier environment and always exposes an idempotent
 * teardown. Commands come exclusively from trusted project configuration and
 * execute through the shell-free process boundary; task/tracker payload is not
 * accepted by this API.
 */
export class VerificationEnvironmentController {
  private readonly config: VerificationEnvironmentConfig;
  private preparePromise?: Promise<readonly VerificationEnvironmentCommandResult[]>;
  private teardownPromise?: Promise<readonly VerificationEnvironmentCommandResult[]>;
  private preparationStarted = false;

  public constructor(config: VerificationEnvironmentConfig) {
    this.config = config;
  }

  public prepare(
    workspacePath: string,
    signal?: AbortSignal,
  ): Promise<readonly VerificationEnvironmentCommandResult[]> {
    this.preparePromise ??= this.runPreparation(workspacePath, signal);
    return this.preparePromise;
  }

  public teardown(workspacePath: string): Promise<readonly VerificationEnvironmentCommandResult[]> {
    if (!this.preparationStarted) return Promise.resolve([]);
    this.teardownPromise ??= this.runTeardown(workspacePath);
    return this.teardownPromise;
  }

  private async runPreparation(
    workspacePath: string,
    signal?: AbortSignal,
  ): Promise<readonly VerificationEnvironmentCommandResult[]> {
    this.preparationStarted = true;
    const setup = await this.runPhase('setup', this.config.setup ?? [], workspacePath, signal);
    const healthcheck = await this.runPhase(
      'healthcheck',
      this.config.healthcheck ?? [],
      workspacePath,
      signal,
    );
    return [...setup, ...healthcheck];
  }

  private async runTeardown(
    workspacePath: string,
  ): Promise<readonly VerificationEnvironmentCommandResult[]> {
    const results: VerificationEnvironmentCommandResult[] = [];
    const errors: unknown[] = [];
    const commands = this.config.teardown ?? [];
    for (let index = 0; index < commands.length; index++) {
      const command = commands[index];
      if (!command) continue;
      try {
        results.push(await this.runCommand('teardown', index, command, workspacePath));
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        'Multiple verification environment teardown commands failed',
      );
    }
    return results;
  }

  private async runPhase(
    phase: 'setup' | 'healthcheck',
    commands: readonly VerificationEnvironmentCommand[],
    workspacePath: string,
    signal?: AbortSignal,
  ): Promise<readonly VerificationEnvironmentCommandResult[]> {
    const results: VerificationEnvironmentCommandResult[] = [];
    for (let index = 0; index < commands.length; index++) {
      const command = commands[index];
      if (!command) continue;
      results.push(await this.runCommand(phase, index, command, workspacePath, signal));
    }
    return results;
  }

  private async runCommand(
    phase: VerificationEnvironmentCommandResult['phase'],
    index: number,
    command: VerificationEnvironmentCommand,
    workspacePath: string,
    parentSignal?: AbortSignal,
  ): Promise<VerificationEnvironmentCommandResult> {
    const timeoutMs =
      command.timeoutSeconds !== undefined
        ? command.timeoutSeconds * 1_000
        : (this.config.defaultCommandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
    const processResult = await executeProcess({
      definition: defineProcess({
        executable: command.executable,
        args: (command.args ?? []).map(controlArgument),
        label: `verification-environment-${phase}`,
      }),
      cwd: workspacePath,
      signal,
    });
    const result: VerificationEnvironmentCommandResult = {
      phase,
      index,
      executable: command.executable,
      exitCode: processResult.exitCode,
    };
    if (processResult.exitCode !== 0) throw new VerificationEnvironmentCommandError(result);
    return result;
  }
}
