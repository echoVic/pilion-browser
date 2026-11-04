import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";
import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";

loadFont({
  family: "PilionCN",
  url: staticFile("fonts/NotoSansSC.ttf"),
  weight: "100 900",
});
registerRoot(RemotionRoot);
