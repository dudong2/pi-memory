import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { MemoryRuntime } from "./runtime.ts";
import { Type } from "@earendil-works/pi-ai";
import { MemoryError, nonempty } from "./contracts.ts";

const contextType = "pi-memory-reference";

export function previousUserRequest(
  ctx: ExtensionContext,
  prompt: string,
): string | undefined {
  const branch = ctx.sessionManager.getBranch();
  let skipCurrent = true;
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "message" || entry.message.role !== "user") continue;
    const content = entry.message.content;
    const text =
      typeof content === "string"
        ? content
        : content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
    if (skipCurrent && text === prompt) {
      skipCurrent = false;
      continue;
    }
    return text || undefined;
  }
  return undefined;
}

function textContent(
  content: string | readonly { type: string; text?: string }[],
): string {
  return typeof content === "string"
    ? content
    : content
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n");
}

export function completedConversation(ctx: ExtensionContext) {
  const branch = ctx.sessionManager.getBranch();
  let assistant: { id: string; text: string } | undefined;
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "message") continue;
    if (entry.message.role === "assistant" && !assistant) {
      if (
        entry.message.stopReason === "aborted" ||
        entry.message.stopReason === "error"
      )
        return undefined;
      const text = textContent(entry.message.content);
      if (text.trim()) assistant = { id: entry.id, text };
    } else if (entry.message.role === "user") {
      if (!assistant) return undefined;
      const text = textContent(entry.message.content);
      if (!text.trim()) return undefined;
      return {
        key: `conversation:${entry.id}:${assistant.id}`,
        text: JSON.stringify({
          user: { role: "user", text },
          assistant: {
            role: "assistant",
            attribution: "report-or-proposal, not user approval",
            text: assistant.text,
          },
        }),
      };
    }
  }
  return undefined;
}

// Exported for a no-model/no-install lifecycle harness.
export function registerMemory(
  pi: ExtensionAPI,
  runtime = new MemoryRuntime(),
  initializeOnSessionStart = true,
): void {
  let reference: { text: string; cwd: string; sessionId: string } | undefined;
  const reset = () => {
    reference = undefined;
    runtime.reset();
  };
  if (initializeOnSessionStart)
    pi.on("session_start", async (_event, ctx) => {
      reset();
      const input = {
        cwd: ctx.cwd,
        sessionId: ctx.sessionManager.getSessionId(),
        prompt: "",
      };
      try {
        await runtime.resume(input);
      } catch (error) {
        if (
          ctx.hasUI &&
          ctx.cwd === input.cwd &&
          ctx.sessionManager.getSessionId() === input.sessionId
        ) {
          ctx.ui.notify(
            `메모리 초기화·전송 재개 불가: ${error instanceof MemoryError ? error.code : "store-unavailable"}`,
            "warning",
          );
        }
      }
    });
  pi.on("session_shutdown", async () => {
    reset();
    await runtime.shutdown();
  });
  pi.on("session_before_switch", reset);
  pi.on("session_before_fork", reset);
  pi.on("session_tree", reset);

  pi.on("before_agent_start", async (event, ctx) => {
    reference = undefined;
    if (event.messageType !== "user") {
      runtime.reset();
      return;
    }
    const cwd = ctx.cwd;
    const sessionId = ctx.sessionManager.getSessionId();
    const result = await runtime.prepare(
      {
        cwd,
        sessionId,
        prompt: event.prompt,
        previousUserPrompt: previousUserRequest(ctx, event.prompt),
      },
      ctx.signal,
    );
    if (!result || result.status === "disabled") return;
    if (ctx.cwd !== cwd || ctx.sessionManager.getSessionId() !== sessionId)
      return;
    reference = {
      cwd,
      sessionId,
      text:
        result.status === "ready"
          ? result.context.text
          : `Memory reference unavailable (${result.code}); this is not an empty search. Do not assume prior approval; ask before risky actions.`,
    };
  });

  pi.on("agent_settled", async (event, ctx) => {
    if (event.aborted) return;
    const conversation = completedConversation(ctx);
    if (!conversation) return;
    const cwd = ctx.cwd,
      sessionId = ctx.sessionManager.getSessionId();
    try {
      await runtime.remember({
        cwd,
        sessionId,
        prompt: "",
        ...conversation,
        kind: "conversation",
      });
    } catch (error) {
      if (
        ctx.cwd === cwd &&
        ctx.sessionManager.getSessionId() === sessionId &&
        ctx.hasUI
      ) {
        ctx.ui.notify(
          `메모리 자동 보존 실패: ${error instanceof MemoryError ? error.code : "store-unavailable"}. 서버 저장 완료로 간주하지 않습니다.`,
          "warning",
        );
      }
    }
  });

  pi.registerTool({
    name: "hindsight_memory",
    label: "Hindsight memory",
    executionMode: "sequential",
    description:
      "Recall scoped memory; optionally Reflect with user confirmation; remember, correct, or retract explicit user memory; inspect queued/submitted/confirmed delivery. Retraction updates a pi-memory document and does not erase conversation history. Never store assistant proposals as user decisions. Common scope requires explicit user intent. Refresh startup notes with user confirmation. No automatic ad-hoc Reflect or cross-project search.",
    parameters: Type.Object({
      action: Type.Union(
        [
          "search",
          "reflect",
          "remember",
          "correct",
          "retract",
          "status",
          "refresh",
        ].map((action) => Type.Literal(action)),
      ),
      query: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
      documentId: Type.Optional(Type.String()),
      scope: Type.Optional(
        Type.Union([Type.Literal("current"), Type.Literal("common")]),
      ),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const input = {
        cwd: ctx.cwd,
        sessionId: ctx.sessionManager.getSessionId(),
        prompt: "",
      };
      const check = () => {
        if (
          signal?.aborted ||
          ctx.cwd !== input.cwd ||
          ctx.sessionManager.getSessionId() !== input.sessionId
        )
          throw new MemoryError("cancelled");
      };
      try {
        let result: unknown;
        if (params.action === "reflect") {
          if (
            !ctx.hasUI ||
            !(await ctx.ui.confirm(
              "Hindsight 심화 조사",
              "현재 Scope와 설정된 공통 기억을 종합합니다. 서버에 설정된 생성 모델의 비용·인증 한도를 사용할 수 있습니다. 실행할까요?",
            ))
          )
            throw new MemoryError("reflect-not-approved");
          check();
          result = await runtime.lookup(
            input,
            nonempty(params.query),
            true,
            signal,
          );
        } else if (params.action === "refresh") {
          if (
            !ctx.hasUI ||
            !(await ctx.ui.confirm(
              "Hindsight 시작 메모 갱신",
              "선택한 현재 Scope 또는 공통 메모를 서버의 생성 모델로 갱신합니다. 모델 사용량이 발생할 수 있으며, 요청 접수는 갱신 완료가 아닙니다. 실행할까요?",
            ))
          )
            throw new MemoryError("refresh-not-approved");
          check();
          result = await runtime.initializeStartup(
            input,
            true,
            params.scope ?? "current",
            signal,
          );
        } else if (params.action === "search")
          result = await runtime.lookup(
            input,
            nonempty(params.query),
            false,
            signal,
          );
        else if (params.action === "status")
          result = await runtime.status(input, signal);
        else
          result = await runtime.remember(
            {
              ...input,
              key: `tool:${toolCallId}`,
              kind: params.action,
              text: nonempty(params.text),
              documentId: params.documentId,
              scope: params.scope,
            },
            signal,
          );
        check();
        return {
          content: [
            {
              type: "text",
              text:
                typeof result === "string" ? result : JSON.stringify(result),
            },
          ],
          details: result,
        };
      } catch (error) {
        throw new MemoryError(
          error instanceof MemoryError ? error.code : "memory-operation-failed",
        );
      }
    },
  });

  pi.on("context", (event, ctx) => {
    // Request-local injection, not a second persistent memory store. Remove any
    // earlier copy instead of accumulating one memory message per user request.
    const messages = event.messages.filter(
      (message) =>
        message.role !== "custom" || message.customType !== contextType,
    );
    if (
      reference &&
      reference.cwd === ctx.cwd &&
      reference.sessionId === ctx.sessionManager.getSessionId()
    ) {
      messages.push({
        role: "custom",
        customType: contextType,
        content: reference.text,
        display: false,
        timestamp: Date.now(),
      });
    }
    return { messages };
  });
}

export default function memoryExtension(pi: ExtensionAPI): void {
  registerMemory(pi);
}
