// web 工作台（spec 驱动，壳在 ./studio-kit.js）
import { renderWorkbench } from './studio-kit.js';

const SPEC = {
  "title": "参考生视频",
  "sub": "MiniMax H3 ref2va · 参考图 / 视频 / 音频 → 短视频",
  "apiBase": "/api/comfyui-refvideo",
  "railTitle": "提示词与参数",
  "fields": [
    {
      "key": "prompt",
      "label": "提示词",
      "type": "textarea",
      "default": "",
      "placeholder": "用 <Picture 1> / <Video 1> / <Audio 1> 指代素材；写动作、镜头、声音。"
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
    },
    {
      "key": "refImageSize",
      "label": "参考图精度",
      "type": "select",
      "options": [
        [
          "match",
          "match（快）"
        ],
        [
          "max",
          "max（更保身份）"
        ]
      ],
      "default": "match"
    }
  ],
  "slots": [
    {
      "key": "images",
      "label": "参考图",
      "max": 9,
      "accept": "image/*",
      "upload": true,
      "output": true
    },
    {
      "key": "videos",
      "label": "参考视频",
      "max": 3,
      "accept": "video/*",
      "upload": true,
      "output": true
    },
    {
      "key": "audios",
      "label": "参考音频",
      "max": 3,
      "accept": "audio/*",
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
