import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron';

type MenuEntry = {
  id: string;
  parentId?: string;
  title: string;
  type: 'normal' | 'separator';
  contexts: string[];
  visible: boolean;
  enabled: boolean;
};

type Click = { menuItemId: string; pageUrl: string; selectionText?: string; linkUrl?: string };

/** Only stores menu descriptions. Actions return to the extension that registered the item. */
export class ExtensionContextMenus {
  private readonly entries = new Map<string, Map<string, MenuEntry>>();

  clear(extensionId: string): void {
    this.entries.delete(extensionId);
  }

  create(extensionId: string, item: Record<string, unknown>): void {
    const {
      id,
      parentId,
      type = 'normal',
      title = '',
      contexts = ['page'],
      visible = true,
      enabled = true,
    } = item;
    if (
      typeof id !== 'string' ||
      !id ||
      id.length > 128 ||
      (parentId !== undefined && typeof parentId !== 'string') ||
      (type !== 'normal' && type !== 'separator') ||
      typeof title !== 'string' ||
      title.length > 256 ||
      !Array.isArray(contexts) ||
      !contexts.length ||
      contexts.some(
        (context) =>
          ![
            'all',
            'page',
            'selection',
            'link',
            'frame',
            'image',
            'video',
            'audio',
            'editable',
            'action',
            'browser_action',
            'page_action',
          ].includes(context),
      ) ||
      item.documentUrlPatterns !== undefined ||
      item.targetUrlPatterns !== undefined ||
      typeof visible !== 'boolean' ||
      typeof enabled !== 'boolean'
    )
      throw new Error('Unsupported context menu item.');
    let entries = this.entries.get(extensionId);
    if (!entries) this.entries.set(extensionId, (entries = new Map()));
    if (entries.has(id) || entries.size >= 100)
      throw new Error('Duplicate item or menu limit reached.');
    if (parentId !== undefined && entries.get(parentId)?.type !== 'normal')
      throw new Error('Invalid context menu parent.');
    entries.set(id, { id, parentId, type, title, contexts: [...contexts], visible, enabled });
  }

  update(extensionId: string, id: unknown, details: Record<string, unknown>): void {
    const entry = typeof id === 'string' ? this.entries.get(extensionId)?.get(id) : undefined;
    if (!entry) throw new Error('Unknown context menu item.');
    for (const key of Object.keys(details))
      if (!['title', 'visible', 'enabled'].includes(key))
        throw new Error('Unsupported menu update.');
    if (
      details.title !== undefined &&
      (typeof details.title !== 'string' || details.title.length > 256)
    )
      throw new Error('Invalid menu title.');
    for (const key of ['visible', 'enabled'] as const)
      if (details[key] !== undefined && typeof details[key] !== 'boolean')
        throw new Error('Invalid menu state.');
    Object.assign(entry, details);
  }

  remove(extensionId: string, id: unknown): void {
    const entries = this.entries.get(extensionId);
    if (typeof id !== 'string' || !entries?.delete(id))
      throw new Error('Unknown context menu item.');
    const deleteChildren = (parent: string) => {
      for (const child of entries.values()) {
        if (child.parentId !== parent) continue;
        entries.delete(child.id);
        deleteChildren(child.id);
      }
    };
    deleteChildren(id);
  }

  items(
    params: ContextMenuParams,
    permitted: (id: string) => boolean,
    click: (id: string, info: Click) => Promise<void>,
  ): MenuItemConstructorOptions[] {
    const results: MenuItemConstructorOptions[] = [];
    const matches = (entry: MenuEntry) =>
      entry.contexts.some(
        (context) =>
          context === 'all' ||
          context === 'page' ||
          (context === 'frame' && !!params.frameURL) ||
          (context === 'editable' && params.isEditable) ||
          context === params.mediaType ||
          (context === 'selection' && !!params.selectionText) ||
          (context === 'link' && !!params.linkURL),
      );
    for (const [extensionId, entries] of this.entries) {
      if (!permitted(extensionId)) continue;
      const children = (parentId?: string): MenuItemConstructorOptions[] =>
        [...entries.values()]
          .filter((entry) => entry.parentId === parentId && entry.visible && matches(entry))
          .map((entry) => {
            if (entry.type === 'separator') return { type: 'separator' };
            const submenu = children(entry.id);
            return {
              enabled: entry.enabled,
              label: entry.title.replace(/%s/g, () => (params.selectionText ?? '').slice(0, 50)),
              ...(submenu.length
                ? { submenu }
                : {
                    click: () =>
                      click(extensionId, {
                        menuItemId: entry.id,
                        pageUrl: params.pageURL,
                        ...(params.selectionText ? { selectionText: params.selectionText } : {}),
                        ...(params.linkURL ? { linkUrl: params.linkURL } : {}),
                      }),
                  }),
            };
          });
      results.push(...children());
    }
    return results;
  }
}
