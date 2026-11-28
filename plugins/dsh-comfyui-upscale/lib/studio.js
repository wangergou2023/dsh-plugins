// web 工作台（spec 驱动，壳在 ./studio-kit.js）
import { renderWorkbench } from './studio-kit.js';

const SPEC = {
  "title": "图片放大",
  "sub": "SeedVR2 7B · 最多 8 倍",
  "apiBase": "/api/comfyui-upscale",
  "railTitle": "参数",
  "fields": [
    {
      "key": "scale",
      "label": "放大倍数",
      "type": "number",
      "min": 1,
      "max": 8,
      "step": 1,
      "default": 4
    },
    {
      "key": "tileSize",
      "label": "分块",
      "type": "number",
      "min": 256,
      "max": 1024,
      "step": 128,
      "default": 512,
      "hint": "显存不够就调小"
    },
    {
      "key": "overlap",
      "label": "重叠",
      "type": "number",
      "min": 0,
      "max": 256,
      "step": 32,
      "default": 128
    },
    {
      "key": "colorCorrection",
      "label": "颜色校正",
      "type": "select",
      "options": [
        [
          "none",
          "none"
        ],
        [
          "lab",
          "lab"
        ],
        [
          "adain",
          "adain"
        ]
      ],
      "default": "none"
    },
    {
      "key": "seed",
      "label": "种子",
      "type": "text",
      "default": "",
      "placeholder": "留空随机"
    }
  ],
  "slots": [
    {
      "key": "image",
      "label": "要放大的图",
      "max": 1,
      "single": true,
      "accept": "image/*",
      "upload": true,
      "output": true,
      "required": true
    }
  ],
  "generate": {
    "path": "/run",
    "result": "image"
  }
};

export function renderStudio() {
  return renderWorkbench(SPEC);
}
