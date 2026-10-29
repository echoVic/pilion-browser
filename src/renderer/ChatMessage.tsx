import {
  createContext,
  useContext,
  isValidElement,
  useState,
  type ReactNode,
} from 'react';
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
import { Check, ChevronDown, Copy, CircleAlert, LoaderCircle, MessageSquare } from 'lucide-react';
import { Checkbox, IconButton } from './ui';
import { formatClock, safeExternalHref } from './panel/links';

/** pre 渲染器把内部 code 标记为块级上下文，块级 code 不应用 inline-code 底色/描边。 */
const BlockCodeContext = createContext(false);

function extractLanguage(node: ReactNode): string | undefined {
  if (!isValidElement(node)) return undefined;
  const className = (node.props as { className?: string }).className;
  return /language-([\w-]+)/.exec(className ?? '')?.[1];
}

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const language = extractLanguage(children);
  const code = isValidElement(children)
    ? (children.props as { children?: ReactNode }).children
    : undefined;
  const text = Array.isArray(code) ? code.join('') : String(code ?? '');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <BlockCodeContext.Provider value={true}>
      <div className="code-block">
        <div className="code-block-header">
          <span className="code-lang">{language ?? 'code'}</span>
          <button
            className="code-copy"
            onClick={copy}
            type="button"
            aria-label={copied ? '已复制' : '复制代码'}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? '已复制' : '复制'}
          </button>
        </div>
        <pre>{children}</pre>
      </div>
    </BlockCodeContext.Provider>
  );
}

function Code({ className, children }: { className?: string; children?: ReactNode }) {
  const inBlock = useContext(BlockCodeContext);
  return (
    <code className={inBlock ? className : clsx('inline-code', className)}>
      {children as React.ReactNode}
    </code>
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
            <Checkbox checked={props.checked} disabled={props.disabled} />
          ) : (
            <input {...props} />
          ),
        // 任务列表项的 task-list-item 类名由 remark-gfm 经 hast properties 透传，无需自定义渲染器
        code: Code,
      }}
    >
      {text}
    </Markdown>
  );
}

function ReasoningPart({ text }: ReasoningMessagePartProps) {
  return (
    <details className="thought">
      <summary>
        思考过程
        <ChevronDown size={12} />
      </summary>
      <div>{text}</div>
    </details>
  );
}

function ToolPart({ toolName, result, isError }: ToolCallMessagePartProps) {
  const running = useAuiState((s) => s.message.status?.type === 'running');
  return (
    <div
      className={clsx('tool-message', { failed: isError, completed: !isError && result })}
      title={`工具调用：${toolName}`}
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
        <div className="msg-body">
          <div className="bubble">
            <MessagePrimitive.Parts components={parts} />
          </div>
        </div>
        {time && <span className="bubble-time">{time}</span>}
      </MessagePrimitive.Root>
    );

  if (kind === 'thought' || kind === 'tool')
    return (
      <MessagePrimitive.Root
        className={clsx('msg', kind === 'thought' ? 'msg-reasoning' : 'msg-tool')}
      >
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
