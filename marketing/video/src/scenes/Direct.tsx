import React from "react";
import { useCurrentFrame } from "remotion";
import {
  Backdrop,
  Title,
  Hint,
  Label,
  green,
  enter,
  Screenshot,
} from "./Common";
export const Direct: React.FC = () => {
  const f = useCurrentFrame();
  const n = Math.floor(Math.max(0, f - 35) * 0.5);
  return (
    <Backdrop>
      <div style={{ position: "absolute", left: 105, top: 225, width: 680 }}>
        <Label>01 / 直接调用</Label>
        <Title size={100}>
          安装一次。
          <br />
          直接<span style={{ color: green }}>开始。</span>
        </Title>
        <Hint>
          Claude Code · Codex
          <br />
          通过 CLI 使用浏览器
        </Hint>
      </div>
      <div
        style={{
          position: "absolute",
          left: 850,
          top: 215,
          width: 950,
          border: "1px solid #769d8350",
          background: "#111c17",
          borderRadius: 24,
          padding: 38,
          boxShadow: "0 20px 80px #0008",
          opacity:
            enter(f, 14) * (1 - Math.min(1, Math.max(0, (f - 160) / 20))),
          transform: `translateY(${(1 - enter(f, 14)) * 45}px)`,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 23,
            color: "#94b4a2",
            marginBottom: 35,
          }}
        >
          <span>Agent terminal</span>
          <span style={{ color: green }}>● Pilion CLI</span>
        </div>
        {[
          '$ export PILION_SPACE=$(pilion space new "调研")',
          "$ TAB=$(pilion new https://example.com)",
          '$ pilion read --tab "$TAB" --json',
          '$ pilion observe --tab "$TAB" --json',
        ].map((line, i) => (
          <div
            key={line}
            style={{
              fontFamily: "Menlo,monospace",
              fontSize: 25,
              lineHeight: 2.25,
              color: i === 0 ? green : "#dbe9e0",
              opacity: enter(f, 30 + i * 36),
            }}
          >
            {i === 0 ? line.slice(0, n) : line}
          </div>
        ))}
        <div
          style={{
            borderTop: "1px solid #2b4235",
            marginTop: 30,
            paddingTop: 30,
            color: "#abc2b4",
            fontSize: 28,
          }}
        >
          读网页 → 识别目标 → 审批与执行
        </div>
      </div>
      {f > 160 ? (
        <div style={{ opacity: Math.min(1, (f - 160) / 20) }}>
          <Screenshot
            file="pilion-agent-skill-install.png"
            left={975}
            top={140}
            width={720}
          />
        </div>
      ) : null}
      <div
        style={{
          position: "absolute",
          left: 930,
          top: 890,
          fontSize: 23,
          color: "#729780",
        }}
      >
        指令与操作流程示意 · 无需连接内置 AI 会话
      </div>
    </Backdrop>
  );
};
