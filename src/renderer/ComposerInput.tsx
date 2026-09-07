import { useEffect, useRef, type RefObject } from 'react';
import type { ThreadComposerRuntime } from '@assistant-ui/react';

type Props = {
  runtime: ThreadComposerRuntime;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  placeholder: string;
};

export function ComposerInput({ runtime, inputRef, placeholder }: Props) {
  const composing = useRef(false);
  useEffect(() => {
    const sync = () => {
      const input = inputRef.current;
      const text = runtime.getState().text;
      if (input && !composing.current && input.value !== text) input.value = text;
    };
    sync();
    return runtime.subscribe(sync);
  }, [runtime, inputRef]);

  return (
    <textarea
      ref={inputRef}
      name="input"
      rows={3}
      aria-label="输入任务"
      placeholder={placeholder}
      defaultValue={runtime.getState().text}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={(event) => {
        composing.current = false;
        runtime.setText(event.currentTarget.value);
      }}
      onChange={(event) => {
        // Native IME owns the marked text until it commits; writing value cancels composition.
        if (composing.current || (event.nativeEvent as InputEvent).isComposing) return;
        runtime.setText(event.currentTarget.value);
      }}
      onKeyDown={(event) => {
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          event.currentTarget.form?.requestSubmit();
        }
      }}
    />
  );
}
