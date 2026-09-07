import { useState } from 'react';
import {
  MessagePrimitive,
  ActionBarPrimitive,
  useAuiState,
  type TextMessagePartProps,
  type ReasoningMessagePartProps,
  type ToolCallMessagePartProps,
} from '@assistant-ui/react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy, CircleAlert, LoaderCircle, MessageSquare } from 'lucide-react';
import { IconButton } from './ui';

function MarkdownPart({ text }: TextMessagePartProps) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => (
          <button
            className="markdown-link"
            onClick={() => {
              if (href && /^https?:\/\//.test(href))
                void window.pilion.tabs.open(href).catch(() => undefined);
            }}
          >
            {children}
          </button>
        ),
      }}
    >
      {text}
    </Markdown>
  );
}
function ReasoningPart({ text }: ReasoningMessagePartProps) {
  return (
    <details className="thought">
      <summary>思考过程</summary>
      <div>{text}</div>
    </details>
  );
}
function ToolPart({ toolName, result, isError }: ToolCallMessagePartProps) {
  const running = useAuiState((s) => s.message.status?.type === 'running');
  return (
    <div className={`tool-message ${isError ? 'failed' : result ? 'completed' : ''}`}>
      {running ? (
        <LoaderCircle size={14} className="spin" />
      ) : isError ? (
        <CircleAlert size={14} />
      ) : (
        <Check size={14} />
      )}
      <span>{toolName}</span>
    </div>
  );
}
const parts = {
  Text: MarkdownPart,
  Reasoning: ReasoningPart,
  tools: { Fallback: ToolPart },
  Empty: () => null,
};

export function ChatMessage() {
  const message = useAuiState((s) => s.message);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const kind = message.metadata.custom.kind ?? message.role;
  const auxiliary = kind === 'thought' || kind === 'tool';
  if (message.content.length === 0) return null;
  return (
    <MessagePrimitive.Root
      className={
        kind === 'system'
          ? 'message-error'
          : auxiliary
            ? 'message-auxiliary'
            : `message ${message.role}`
      }
      role={kind === 'system' ? 'alert' : undefined}
    >
      {kind === 'system' && <CircleAlert size={16} />}
      {kind === 'assistant' && (
        <div className="message-author">
          <span className="agent-avatar">
            <MessageSquare size={12} />
          </span>
          Agent
        </div>
      )}
      <div className="message-body">
        <MessagePrimitive.Parts components={parts} />
      </div>
      {kind === 'assistant' && message.status?.type !== 'running' && (
        <ActionBarPrimitive.Root className="message-footer" hideWhenRunning>
          <time>
            {message.createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </time>
          <IconButton
            label={copied ? '已复制' : copyError ? '复制失败，重试' : '复制回复'}
            onClick={async () => {
              try {
                await window.pilion.workspace.copyMessage(message.id);
                setCopied(true);
                setCopyError(false);
              } catch {
                setCopyError(true);
              }
            }}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </IconButton>
        </ActionBarPrimitive.Root>
      )}
    </MessagePrimitive.Root>
  );
}
