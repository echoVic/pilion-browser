import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ElementRefSchema,
  PressKeySchema,
  PressModifierSchema,
  type ToolName,
} from "../../shared/contracts.js";

export function createBrowserMcpServer(
  execute: (name: ToolName, args: Record<string, unknown>) => Promise<unknown>,
): McpServer {
  const server = new McpServer({ name: "pilion-browser", version: "0.2.0" });
  const tab = { tabId: z.string().min(1).max(256).optional() };
  const target = { ...tab, elementRef: ElementRefSchema };
  function register(
    name: ToolName,
    description: string,
    inputSchema: z.ZodRawShape,
  ) {
    server.registerTool(
      name.replaceAll(".", "_"),
      { description, inputSchema },
      async (input) => {
        try {
          const result = await execute(name, input as Record<string, unknown>);
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : String(error),
              },
            ],
          };
        }
      },
    );
  }
  register("browser.tabs.list", "List tabs shared with this agent.", {});
  register("browser.tabs.open", "Open a browser tab.", {
    url: z.string().max(8192).optional(),
  });
  register("browser.tabs.activate", "Activate a tab.", {
    tabId: z.string().min(1).max(256),
  });
  register("browser.tabs.close", "Close a tab.", {
    tabId: z.string().min(1).max(256),
  });
  register("browser.navigate", "Navigate to a URL.", {
    ...tab,
    url: z.string().min(1).max(8192),
  });
  register("browser.page_info", "Read page title, URL and visible text.", tab);
  register(
    "browser.observe",
    "Observe page elements. Use fresh element references for interactions.",
    tab,
  );
  register("browser.click", "Click an observed element.", target);
  register("browser.type", "Type into an observed element.", {
    ...target,
    text: z.string().max(100_000),
    replace: z.boolean().optional(),
  });
  register("browser.select", "Select an option.", {
    ...target,
    value: z.string().min(1).max(10_000),
  });
  register("browser.check", "Set a checkbox or radio.", {
    ...target,
    checked: z.boolean(),
  });
  register("browser.press", "Press a supported key.", {
    ...target,
    key: PressKeySchema,
    modifiers: z.array(PressModifierSchema).max(1).optional(),
  });
  return server;
}
