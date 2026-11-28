// web 工作台（spec 驱动，壳在 ./studio-kit.js）
import { renderWorkbench } from './studio-kit.js';

const SPEC = {
  "title": "图片编辑",
  "sub": "Qwen-Image 2.1 · 1–10 张参考图 + 指令 → 新画面",
  "apiBase": "/api/comfyui-imgedit",
  "railTitle": "指令与参数",
  "fields": [
    {
      "key": "prompt",
      "label": "编辑指令",
      "type": "textarea",
      "default": "",
      "placeholder": "例：把第 2 张的衣服换给第 1 张的人物；或：把背景换成雨夜街道。"
    },
    {
      "key": "negative",
      "label": "负向",
      "type": "text",
      "default": "",
      "placeholder": "可选"
    },
    {
      "key": "steps",
      "label": "步数",
      "type": "number",
      "min": 4,
      "max": 60,
      "step": 1,
      "default": 25
    },
    {
      "key": "cfg",
      "label": "CFG",
      "type": "number",
      "min": 0,
      "max": 10,
      "step": 0.1,
      "default": 1
    },
    {
      "key": "seed",
      "label": "种子",
      "type": "text",
      "default": "",
      "placeholder": "留空随机"
    },
    {
      "key": "fixedSize",
      "label": "固定尺寸",
      "type": "check",
      "default": false
    },
    {
      "key": "width",
      "label": "宽",
      "type": "number",
      "min": 256,
      "max": 2048,
      "step": 64,
      "default": 1024
    },
    {
      "key": "height",
      "label": "高",
      "type": "number",
      "min": 256,
      "max": 2048,
      "step": 64,
      "default": 1024
    }
  ],
  "slots": [
    {
      "key": "images",
      "label": "参考图",
      "max": 10,
      "accept": "image/*",
      "upload": true,
      "output": true,
      "required": true
    }
  ],
  "generate": {
    "path": "/run",
    "result": "image"
  },
  "polish": {
    "path": "/polish",
    "field": "prompt"
  }
};

export function renderStudio() {
  return renderWorkbench(SPEC);
}
