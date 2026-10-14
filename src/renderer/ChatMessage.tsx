import { Children, isValidElement, useState, type ReactElement } from 'react';
import clsx from 'clsx';
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
import { Check, ChevronRight, CircleAlert, LoaderCircle, MessageSquare, Copy } from 'lucide-react';
import { IconButton } from './ui';
import { formatClock, safeExternalHref } from './panel/links';

function CodeBlock({ children }: { children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const code = Children.toArray(children).find(isValidElement) as
    ReactElement<{ className?: string; children?: React.ReactNode }> | undefined;
  const className = code?.props.className ?? '';
  const lang = /language-([\w-]+)/.exec(className)?.[1];
  const raw = String(code?.props.children ?? '');
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{lang ? lang : 'code'}</span>
        <button
          type="button"
          aria-label={copied ? '已复制' : '复制代码'}
          onClick={() =>
            void navigator.clipboard?.writeText(raw).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            })
          }
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

function MarkdownPart({ text }: TextMessagePartProps) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => {
          const safe = safeExternalHref(href);
          return (
            <button
              className="md-link"
              onClick={() => {
                if (safe) void window.pilion.tabs.open(safe).catch(() => undefined);
              }}
            >
              {children}
            </button>
          );
        },
        pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        table: ({ children }) => (
          <div className="md-table-wrap">
            <table className="md-table">{children}</table>
          </div>
        ),
        input: (props) =>
          props.type === 'checkbox' ? (
            <span className="task-check" data-checked={props.checked ?? false}>
              {props.checked ? <Check size={11} /> : null}
            </span>
          ) : (
            <input {...props} />
          ),
        li: ({ children, ...props }) => {
          const checked = (props as { checked?: boolean }).checked;
          return <li className={clsx('task-list-item', { done: checked })}>{children}</li>;
        },
        code: ({ className, children }) => (
          <code className={clsx('inline-code', className)}>{children as React.ReactNode}</code>
        ),
      }}
    >
      {text}
    </Markdown>
  );
}

function ReasoningPart({ text }: ReasoningMessagePartProps) {
  return (
    <details className="reasoning">
      <summary>
        思考过程
        <ChevronRight size={12} className="chev-sm" />
      </summary>
      <div className="reason-text">{text}</div>
    </details>
  );
}

function ToolPart({ toolName, result, isError }: ToolCallMessagePartProps) {
  const running = useAuiState((s) => s.message.status?.type === 'running');
  return (
    <div
      className={clsx('tool-row', { 'is-running': running })}
      role={running ? 'status' : undefined}
    >
      {running ? (
        <LoaderCircle size={14} className="ic-spin" />
      ) : isError ? (
        <CircleAlert size={14} className="ic-fail" />
      ) : (
        <Check size={14} className="ic-done" />
      )}
      <span className="tool-name">{toolName}</span>
      {result != null && !running && <span className="tool-result">{String(result)}</span>}
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
  if (message.content.length === 0) return null;
  const time = formatClock(String(message.createdAt));

  if (kind === 'system')
    return (
      <MessagePrimitive.Root className="sys-msg" role="alert">
        <CircleAlert size={14} />
        <div>
          <MessagePrimitive.Parts components={parts} />
        </div>
      </MessagePrimitive.Root>
    );

  if (kind === 'user')
    return (
      <MessagePrimitive.Root className="msg msg-user">
        <div className="bubble">
          <MessagePrimitive.Parts components={parts} />
        </div>
        {time && <span className="bubble-time">{time}</span>}
      </MessagePrimitive.Root>
    );

  if (kind === 'thought' || kind === 'tool')
    return (
      <MessagePrimitive.Root className={clsx('msg', kind === 'thought' ? 'msg-reasoning' : 'msg-tool')}>
        <div className="msg-body">
          <MessagePrimitive.Parts components={parts} />
        </div>
      </MessagePrimitive.Root>
    );

  return (
    <MessagePrimitive.Root className="msg msg-assistant">
      <div className="author-row">
        <span className="agent-avatar">
          <MessageSquare size={12} />
        </span>
        Agent
        {time && <time>{time}</time>}
      </div>
      <div className="msg-body">
        <MessagePrimitive.Parts components={parts} />
      </div>
      {message.status?.type !== 'running' && (
        <ActionBarPrimitive.Root className="msg-footer" hideWhenRunning>
          <time>{time}</time>
          <IconButton
            label={copied ? '已复制' : copyError ? '复制失败，重试' : '复制回复'}
            className={clsx({ copied })}
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
