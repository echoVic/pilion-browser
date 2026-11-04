import React from "react";
import { useCurrentFrame } from "remotion";
import {
  Backdrop,
  Label,
  Title,
  Hint,
  Screenshot,
  green,
  enter,
} from "./Common";
export const Control: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <Backdrop>
      <div
        style={{
          position: "absolute",
          left: 105,
          top: 240,
          width: 640,
          zIndex: 2,
        }}
      >
        <Label>03 / 你来决定</Label>
        <Title size={98}>
          先问过你。
          <br />再<span style={{ color: green }}>行动。</span>
        </Title>
        <Hint>确认模式 · 审计 · 随时接管</Hint>
      </div>
      <Screenshot
        file="pilion-external-approval.png"
        left={780}
        top={185}
        width={1060}
      />
      <div
        style={{
          position: "absolute",
          left: 1010,
          top: 690,
          width: 700,
          background: "#1d3427",
          border: "1px solid #71c89466",
          boxShadow: "0 20px 65px #000b",
          borderRadius: 22,
          padding: 28,
          opacity: enter(f, 50),
          transform: `translateY(${(1 - enter(f, 50)) * 35}px)`,
        }}
      >
        <div style={{ fontSize: 27, marginBottom: 23 }}>
          操作前，先取得你的许可
        </div>
        <div style={{ display: "flex", gap: 16, fontSize: 25 }}>
          <div
            style={{
              padding: "12px 28px",
              borderRadius: 12,
              background: green,
              color: "#123121",
              fontWeight: 600,
            }}
          >
            批准一次
          </div>
          <div
            style={{
              padding: "12px 28px",
              border: "1px solid #739c7b55",
              borderRadius: 12,
              color: "#c6dbcd",
            }}
          >
            停止任务
          </div>
        </div>
        <div style={{ fontSize: 18, color: "#95b7a1", marginTop: 16 }}>
          审批操作示意
        </div>
      </div>
    </Backdrop>
  );
};
