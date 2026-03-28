import * as vscode from "vscode";
import { logger } from "./logger";

export interface StoppedEvent {
  threadId: number;
  reason: string;
  description?: string;
  allThreadsStopped?: boolean;
}

export interface DebugState {
  status: "running" | "stopped" | "noSession";
  sessionId?: string;
  sessionName?: string;
  stoppedThreadId?: number;
  stoppedReason?: string;
  stoppedFile?: string;
  stoppedLine?: number;
}

type EventWaiter = {
  resolve: (event: { event: string; threadId?: number; reason?: string; file?: string; line?: number }) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class DebugStateManager {
  private stoppedEvent: StoppedEvent | null = null;
  private stoppedLocation: { file?: string; line?: number } | null = null;
  private waiters: EventWaiter[] = [];
  private disposables: vscode.Disposable[] = [];

  constructor() {
    // Track DAP messages to capture stopped events
    this.disposables.push(
      vscode.debug.registerDebugAdapterTrackerFactory("*", {
        createDebugAdapterTracker: (_session: vscode.DebugSession) => {
          return {
            onDidSendMessage: (message: { type?: string; event?: string; body?: Record<string, unknown> }) => {
              if (message.type === "event" && message.event === "stopped") {
                const body = message.body || {};
                this.stoppedEvent = {
                  threadId: (body.threadId as number) || 0,
                  reason: (body.reason as string) || "unknown",
                  description: body.description as string | undefined,
                  allThreadsStopped: body.allThreadsStopped as boolean | undefined,
                };
                logger.info(`Debug stopped: thread=${this.stoppedEvent.threadId} reason=${this.stoppedEvent.reason}`);

                // Try to get the stopped location from the stack trace
                this.resolveStoppedLocation().then(() => {
                  this.notifyWaiters("stopped");
                });
              }
            },
          };
        },
      }),
    );

    // Track session termination
    this.disposables.push(
      vscode.debug.onDidTerminateDebugSession((_session) => {
        logger.info("Debug session terminated");
        this.stoppedEvent = null;
        this.stoppedLocation = null;
        this.notifyWaiters("terminated");
      }),
    );

    // Track session start — reset state
    this.disposables.push(
      vscode.debug.onDidStartDebugSession((session) => {
        logger.info(`Debug session started: ${session.name} (${session.id})`);
        this.stoppedEvent = null;
        this.stoppedLocation = null;
      }),
    );
  }

  private async resolveStoppedLocation(): Promise<void> {
    const session = vscode.debug.activeDebugSession;
    if (!session || !this.stoppedEvent) return;
    try {
      const stackResponse = await session.customRequest("stackTrace", {
        threadId: this.stoppedEvent.threadId,
        startFrame: 0,
        levels: 1,
      });
      const frame = stackResponse?.stackFrames?.[0];
      if (frame?.source?.path) {
        this.stoppedLocation = {
          file: frame.source.path,
          line: frame.line,
        };
      }
    } catch (err) {
      logger.error(`Failed to resolve stopped location: ${err}`);
    }
  }

  private notifyWaiters(event: string): void {
    const waiters = this.waiters.splice(0);
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.resolve({
        event,
        threadId: this.stoppedEvent?.threadId,
        reason: this.stoppedEvent?.reason,
        file: this.stoppedLocation?.file,
        line: this.stoppedLocation?.line,
      });
    }
  }

  getState(): DebugState {
    const session = vscode.debug.activeDebugSession;
    if (!session) return { status: "noSession" };

    const state: DebugState = {
      sessionId: session.id,
      sessionName: session.name,
      status: this.stoppedEvent ? "stopped" : "running",
    };

    if (this.stoppedEvent) {
      state.stoppedThreadId = this.stoppedEvent.threadId;
      state.stoppedReason = this.stoppedEvent.reason;
      state.stoppedFile = this.stoppedLocation?.file;
      state.stoppedLine = this.stoppedLocation?.line;
    }

    return state;
  }

  /** Mark the state as running (after continue/step). */
  clearStopped(): void {
    this.stoppedEvent = null;
    this.stoppedLocation = null;
  }

  waitForEvent(timeoutMs: number): Promise<{ event: string; threadId?: number; reason?: string; file?: string; line?: number }> {
    // If already stopped, return immediately
    if (this.stoppedEvent) {
      return Promise.resolve({
        event: "stopped",
        threadId: this.stoppedEvent.threadId,
        reason: this.stoppedEvent.reason,
        file: this.stoppedLocation?.file,
        line: this.stoppedLocation?.line,
      });
    }

    // If no active session, return immediately
    if (!vscode.debug.activeDebugSession) {
      return Promise.resolve({ event: "noSession" });
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) this.waiters.splice(idx, 1);
        resolve({ event: "timeout" });
      }, timeoutMs);
      this.waiters.push({ resolve, timer });
    });
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.resolve({ event: "disposed" });
    }
    this.waiters = [];
  }
}
