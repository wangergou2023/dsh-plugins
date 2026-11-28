// web 工作台（spec 驱动，壳在 ./studio-kit.js）
import { renderWorkbench } from './studio-kit-2.js';

const SPEC = {
  "title": "首尾帧视频",
  "sub": "MiniMax H3 i2v · 首帧 →（尾帧）之间发生了什么",
  "apiBase": "/api/comfyui-firstlast",
  "railTitle": "提示词与参数",
  "fields": [
    {
      "key": "prompt",
      "label": "过程描述",
      "type": "textarea",
      "default": "",
      "placeholder": "描述从首帧到尾帧之间发生了什么：动作、镜头、光线变化。"
    },
    {
      "key": "aspectRatio",
      "label": "比例",
      "type": "select",
      "options": [
        [
          "16:9 (Widescreen)",
          "16:9"
        ],
        [
          "9:16 (Portrait Widescreen)",
          "9:16"
        ],
        [
          "1:1 (Square)",
          "1:1"
        ],
        [
          "4:3 (Standard)",
          "4:3"
        ],
        [
          "3:4 (Portrait Standard)",
          "3:4"
        ],
        [
          "21:9 (Ultrawide)",
          "21:9"
        ],
        [
          "3:2 (Photo)",
          "3:2"
        ],
        [
          "2:3 (Portrait Photo)",
          "2:3"
        ]
      ],
      "default": "16:9 (Widescreen)"
    },
    {
      "key": "megapixels",
      "label": "像素(MP)",
      "type": "number",
      "min": 0.2,
      "max": 1,
      "step": 0.1,
      "default": 0.4
    },
    {
      "key": "durationSeconds",
      "label": "时长(秒)",
      "type": "number",
      "min": 2,
      "max": 15,
      "step": 0.5,
      "default": 5
    },
    {
      "key": "seed",
      "label": "种子",
      "type": "text",
      "default": "",
      "placeholder": "留空随机"
    },
    {
      "key": "lightning",
      "label": "4 步加速",
      "type": "check",
      "default": true
    }
  ],
  "slots": [
    {
      "key": "firstFrame",
      "label": "首帧（必填）",
      "max": 1,
      "single": true,
      "accept": "image/*",
      "upload": true,
      "output": true,
      "required": true
    },
    {
      "key": "lastFrame",
      "label": "尾帧（可选）",
      "max": 1,
      "single": true,
      "accept": "image/*",
      "upload": true,
      "output": true
    }
  ],
  "generate": {
    "path": "/run",
    "result": "video"
  },
  "polish": {
    "path": "/polish",
    "field": "prompt"
  }
};

export function renderStudio() {
  return renderWorkbench(SPEC);
}
