import React from "react";
import { Backdrop, Label, Title, Hint, green, Screenshot } from "./Common";
export const Spaces: React.FC = () => {
  return (
    <Backdrop>
      <div style={{ position: "absolute", left: 105, top: 220, width: 690 }}>
        <Label>02 / 独立任务空间</Label>
        <Title size={100}>
          它在工作。
          <br />
          你继续<span style={{ color: green }}>浏览。</span>
        </Title>
        <Hint>每个对话，各有一片空间</Hint>
      </div>
      <Screenshot
        file="pilion-agent-spaces-background.png"
        width={1050}
        left={800}
        top={210}
      />
      <div
        style={{
          position: "absolute",
          left: 990,
          top: 162,
          fontSize: 25,
          color: "#a9c8b5",
        }}
      >
        任务空间独立 · 前台页面保持可见
      </div>
    </Backdrop>
  );
};
