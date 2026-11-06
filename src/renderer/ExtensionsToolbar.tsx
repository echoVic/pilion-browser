import { useEffect, useState } from 'react';
import { Puzzle } from 'lucide-react';
import type { ExtensionView } from '../shared/contracts';
import { ExtensionIcon } from './ExtensionsMenu';
import { IconButton } from './ui';

export function ExtensionsToolbar({
  disabled,
  run,
}: {
  disabled: boolean;
  run(action: () => Promise<unknown>): Promise<unknown>;
}) {
  const [items, setItems] = useState<ExtensionView[]>([]);
  useEffect(() => {
    let live = true;
    const refresh = () =>
      void window.pilion.browserData
        .extensions()
        .then((items) => {
          if (live) setItems(items);
        })
        .catch(() => undefined);
    refresh();
    const off = window.pilion.browserData.onExtensionsChanged(refresh);
    return () => {
      live = false;
      off();
    };
  }, []);
  return (
    <div className="extensions-toolbar">
      <div className="extensions-toolbar-pinned">
        {items
          .filter((item) => item.pinned && item.enabled && !item.error)
          .map((item) => (
            <IconButton
              key={item.id}
              label={`打开扩展 ${item.name}`}
              title={item.name}
              disabled={disabled}
              onClick={() => void run(() => window.pilion.browserData.open(item.id))}
            >
              <ExtensionIcon item={item} />
            </IconButton>
          ))}
      </div>
      <IconButton
        label="扩展程序"
        title="扩展程序"
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={(event) => {
          const { x, y, width, height } = event.currentTarget.getBoundingClientRect();
          void run(() => window.pilion.browserData.toolbar({ x, y, width, height }));
        }}
      >
        <Puzzle size={18} />
      </IconButton>
    </div>
  );
}
