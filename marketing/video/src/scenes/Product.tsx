import React from "react";
import { useCurrentFrame } from "remotion";
import { Backdrop, Label, Title, Screenshot, green, enter } from "./Common";
export const Product: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <Backdrop>
      <div style={{ position: "absolute", left: 110, top: 125, zIndex: 2 }}>
        <Label>04 / 熟悉的日常</Label>
        <Title size={80}>
          好用的浏览器。<span style={{ color: green }}>再多一个帮手。</span>
        </Title>
      </div>
      <Screenshot
        file="pilion-product-dark.png"
        width={1010}
        left={760}
        top={265}
      />
      {["空间整理", "固定标签", "快捷搜索"].map((t, i) => (
        <div
          key={t}
          style={{
            position: "absolute",
            left: 160,
            top: 385 + i * 140,
            zIndex: 3,
            padding: "17px 34px",
            borderRadius: 40,
            border: "1px solid #739a8155",
            background: "#182d21ef",
            fontSize: 30,
            color: "#d8efe1",
            opacity: enter(f, 35 + i * 15),
            transform: `translateY(${(1 - enter(f, 35 + i * 15)) * 30}px)`,
          }}
        >
          {t}
        </div>
      ))}
    </Backdrop>
  );
};
