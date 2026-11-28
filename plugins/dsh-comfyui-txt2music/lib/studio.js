// web 工作台（spec 驱动，壳在 ./studio-kit.js）
import { renderWorkbench } from './studio-kit.js';

const SPEC = {
  "title": "文生音乐",
  "sub": "YuE2 3B · 曲风 + 歌词 → 整首歌",
  "apiBase": "/api/comfyui-txt2music",
  "railTitle": "曲风与歌词",
  "fields": [
    {
      "key": "lyricsTheme",
      "label": "主题 / 一句话（给写歌词用）",
      "type": "text",
      "default": "",
      "placeholder": "例：末班地铁上，两个人谁都没先开口"
    },
    {
      "key": "style",
      "label": "曲风",
      "type": "textarea",
      "default": "Upbeat indie pop with warm female vocals, bright electric guitars, punchy drums, melodic bass",
      "placeholder": "Upbeat indie pop, warm female vocals…"
    },
    {
      "key": "lyrics",
      "label": "歌词",
      "type": "textarea",
      "default": "[Verse]\nMorning light across the window\nCity waking down below\n\n[Chorus]\nWe are running through the daylight\nNever looking back again",
      "placeholder": "用 [Verse] / [Chorus] 分段"
    },
    {
      "key": "duration",
      "label": "时长(秒)",
      "type": "number",
      "min": 15,
      "max": 600,
      "step": 15,
      "default": 120
    },
    {
      "key": "format",
      "label": "格式",
      "type": "select",
      "options": [
        [
          "flac",
          "flac"
        ],
        [
          "mp3",
          "mp3"
        ],
        [
          "opus",
          "opus"
        ]
      ],
      "default": "flac"
    },
    {
      "key": "steps",
      "label": "步数",
      "type": "number",
      "min": 4,
      "max": 80,
      "step": 1,
      "default": 32
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
      "key": "useAbc",
      "label": "先写曲式（ABC）",
      "type": "check",
      "default": true
    },
    {
      "key": "mode",
      "label": "模式",
      "type": "select",
      "options": [
        [
          "full",
          "旋律+和弦"
        ],
        [
          "melody",
          "仅旋律"
        ]
      ],
      "default": "full"
    }
  ],
  "slots": [],
  "generate": {
    "path": "/run",
    "result": "audio"
  },
  "extra": [
    {
      "label": "✨ 写歌词",
      "path": "/lyrics",
      "fill": "lyrics",
      "body": {
        "theme": "@lyricsTheme",
        "style": "@style",
        "mode": "write"
      }
    },
    {
      "label": "润色歌词",
      "path": "/lyrics",
      "fill": "lyrics",
      "body": {
        "theme": "@lyricsTheme",
        "style": "@style",
        "mode": "polish"
      }
    }
  ]
};

export function renderStudio() {
  return renderWorkbench(SPEC);
}
