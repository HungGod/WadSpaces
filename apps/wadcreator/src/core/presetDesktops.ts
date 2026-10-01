// The desktops of the six hand-written workspaces (Wadspaces-David), as the
// Builder shows them. Generated once from the UI mockup's seed data; the
// icons match what's on screen in each image. Web icons in the Kale workspaces
// open as Kale Browser apps, as the images do.
import type { Layout } from "./model";

export const PRESET_DESKTOPS: Record<string, { description: string; layout: Layout }> = {
  "writing": {
    "description": "writing",
    "layout": {
      "wallpaper": {
        "type": "image",
        "value": "/wallpapers/cosmic-bodybuilding.png"
      },
      "icons": [
        {
          "id": "obsidian-0-0",
          "appId": "obsidian",
          "label": "Obsidian",
          "iconUrl": "https://www.google.com/s2/favicons?domain=obsidian.md&sz=128",
          "color": "#7c3aed",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 0
          }
        }
      ],
      "grid": true
    }
  },
  "iq-dev": {
    "description": "video game dev",
    "layout": {
      "wallpaper": {
        "type": "image",
        "value": "/wallpapers/intelligence-quest.png"
      },
      "icons": [
        {
          "id": "claude-code-0-0",
          "appId": "claude-code",
          "label": "Claude Code",
          "iconUrl": "/icons/claude-code.svg",
          "color": "#d97757",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 0
          }
        },
        {
          "id": "spritesheet-packer-0-1",
          "appId": "spritesheet-packer",
          "label": "Spritesheet Packer",
          "iconUrl": "https://www.google.com/s2/favicons?domain=codeandweb.com&sz=128",
          "color": "#2b2b2b",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 1
          },
          "launcher": "kale"
        },
        {
          "id": "github-0-2",
          "appId": "github",
          "label": "GitHub",
          "iconUrl": "https://www.google.com/s2/favicons?domain=github.com&sz=128",
          "color": "#24292f",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 2
          },
          "launcher": "kale"
        },
        {
          "id": "claude-0-3",
          "appId": "claude",
          "label": "Claude",
          "iconUrl": "https://www.google.com/s2/favicons?domain=claude.ai&sz=128",
          "color": "#c96442",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 3
          },
          "launcher": "kale"
        },
        {
          "id": "piskel-0-4",
          "appId": "piskel",
          "label": "Piskel",
          "iconUrl": "https://www.google.com/s2/favicons?domain=piskelapp.com&sz=128",
          "color": "#3a3a4a",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 4
          },
          "launcher": "kale"
        },
        {
          "id": "tiled-0-5",
          "appId": "tiled",
          "label": "Tiled",
          "iconUrl": "https://www.google.com/s2/favicons?domain=mapeditor.org&sz=128",
          "color": "#4a8c5c",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 5
          }
        },
        {
          "id": "vscode-0-6",
          "appId": "vscode",
          "label": "VS Code",
          "iconUrl": "https://www.google.com/s2/favicons?domain=code.visualstudio.com&sz=128",
          "color": "#0e7fd6",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 6
          }
        }
      ],
      "grid": true
    }
  },
  "wad-c": {
    "description": "development wadspaces for the namesake application",
    "layout": {
      "wallpaper": {
        "type": "image",
        "value": "/wallpapers/wadspaces-dev.png"
      },
      "icons": [
        {
          "id": "chrome-0-0",
          "appId": "chrome",
          "label": "Chrome",
          "iconUrl": "https://www.google.com/s2/favicons?domain=google.com/chrome&sz=128",
          "color": "#4285f4",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 0
          }
        },
        {
          "id": "claude-code-0-1",
          "appId": "claude-code",
          "label": "Claude Code",
          "iconUrl": "/icons/claude-code.svg",
          "color": "#d97757",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 1
          }
        },
        {
          "id": "vscode-0-2",
          "appId": "vscode",
          "label": "VS Code",
          "iconUrl": "https://www.google.com/s2/favicons?domain=code.visualstudio.com&sz=128",
          "color": "#0e7fd6",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 2
          }
        },
        {
          "id": "claude-0-3",
          "appId": "claude",
          "label": "Claude",
          "iconUrl": "https://www.google.com/s2/favicons?domain=claude.ai&sz=128",
          "color": "#c96442",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 3
          }
        },
        {
          "id": "github-0-4",
          "appId": "github",
          "label": "GitHub",
          "iconUrl": "https://www.google.com/s2/favicons?domain=github.com&sz=128",
          "color": "#24292f",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 4
          }
        },
        {
          "id": "google-cloud-0-5",
          "appId": "google-cloud",
          "label": "Google Cloud",
          "iconUrl": "https://www.google.com/s2/favicons?domain=cloud.google.com&sz=128",
          "color": "#4285f4",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 5
          }
        },
        {
          "id": "openrouter-0-6",
          "appId": "openrouter",
          "label": "OpenRouter",
          "iconUrl": "https://www.google.com/s2/favicons?domain=openrouter.ai&sz=128",
          "color": "#6467f2",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 6
          }
        }
      ],
      "grid": true
    }
  },
  "kale-b": {
    "description": "development wadspace for the kale browser",
    "layout": {
      "wallpaper": {
        "type": "image",
        "value": "/wallpapers/kale-browser.png"
      },
      "icons": [
        {
          "id": "claude-code-0-0",
          "appId": "claude-code",
          "label": "Claude Code",
          "iconUrl": "/icons/claude-code.svg",
          "color": "#d97757",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 0
          }
        },
        {
          "id": "github-0-1",
          "appId": "github",
          "label": "GitHub",
          "iconUrl": "https://www.google.com/s2/favicons?domain=github.com&sz=128",
          "color": "#24292f",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 1
          },
          "launcher": "kale"
        },
        {
          "id": "claude-0-2",
          "appId": "claude",
          "label": "Claude",
          "iconUrl": "https://www.google.com/s2/favicons?domain=claude.ai&sz=128",
          "color": "#c96442",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 2
          },
          "launcher": "kale"
        },
        {
          "id": "openrouter-0-3",
          "appId": "openrouter",
          "label": "OpenRouter",
          "iconUrl": "https://www.google.com/s2/favicons?domain=openrouter.ai&sz=128",
          "color": "#6467f2",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 3
          },
          "launcher": "kale"
        },
        {
          "id": "vscode-0-4",
          "appId": "vscode",
          "label": "VS Code",
          "iconUrl": "https://www.google.com/s2/favicons?domain=code.visualstudio.com&sz=128",
          "color": "#0e7fd6",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 4
          }
        }
      ],
      "grid": true
    }
  },
  "vanua-academy": {
    "description": "Development Wadspace for vanuaacademy.com",
    "layout": {
      "wallpaper": {
        "type": "image",
        "value": "/wallpapers/vanua-academy.png"
      },
      "icons": [
        {
          "id": "chrome-0-0",
          "appId": "chrome",
          "label": "Chrome",
          "iconUrl": "https://www.google.com/s2/favicons?domain=google.com/chrome&sz=128",
          "color": "#4285f4",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 0
          }
        },
        {
          "id": "claude-code-0-1",
          "appId": "claude-code",
          "label": "Claude Code",
          "iconUrl": "/icons/claude-code.svg",
          "color": "#d97757",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 1
          }
        },
        {
          "id": "vscode-0-2",
          "appId": "vscode",
          "label": "VS Code",
          "iconUrl": "https://www.google.com/s2/favicons?domain=code.visualstudio.com&sz=128",
          "color": "#0e7fd6",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 2
          }
        },
        {
          "id": "gmail-0-3",
          "appId": "gmail",
          "label": "Gmail",
          "iconUrl": "https://www.google.com/s2/favicons?domain=mail.google.com&sz=128",
          "color": "#d93025",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 3
          }
        },
        {
          "id": "claude-0-4",
          "appId": "claude",
          "label": "Claude",
          "iconUrl": "https://www.google.com/s2/favicons?domain=claude.ai&sz=128",
          "color": "#c96442",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 4
          }
        },
        {
          "id": "github-0-5",
          "appId": "github",
          "label": "GitHub",
          "iconUrl": "https://www.google.com/s2/favicons?domain=github.com&sz=128",
          "color": "#24292f",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 5
          }
        },
        {
          "id": "google-cloud-0-6",
          "appId": "google-cloud",
          "label": "Google Cloud",
          "iconUrl": "https://www.google.com/s2/favicons?domain=cloud.google.com&sz=128",
          "color": "#4285f4",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 6
          }
        },
        {
          "id": "google-workspace-0-7",
          "appId": "google-workspace",
          "label": "Google Workspace",
          "iconUrl": "https://www.google.com/s2/favicons?domain=workspace.google.com&sz=128",
          "color": "#4285f4",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 7
          }
        },
        {
          "id": "google-drive-1-0",
          "appId": "google-drive",
          "label": "Google Drive",
          "iconUrl": "https://www.google.com/s2/favicons?domain=drive.google.com&sz=128",
          "color": "#1fa463",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 1,
            "row": 0
          }
        }
      ],
      "grid": true
    }
  },
  "kale-p": {
    "description": "development project for android phone kale applications",
    "layout": {
      "wallpaper": {
        "type": "image",
        "value": "/wallpapers/kale-phone.png"
      },
      "icons": [
        {
          "id": "android-studio-0-0",
          "appId": "android-studio",
          "label": "Android Studio",
          "iconUrl": "https://www.google.com/s2/favicons?domain=developer.android.com&sz=128",
          "color": "#3ddc84",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 0
          }
        },
        {
          "id": "claude-code-0-1",
          "appId": "claude-code",
          "label": "Claude Code",
          "iconUrl": "/icons/claude-code.svg",
          "color": "#d97757",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 1
          }
        },
        {
          "id": "github-0-2",
          "appId": "github",
          "label": "GitHub",
          "iconUrl": "https://www.google.com/s2/favicons?domain=github.com&sz=128",
          "color": "#24292f",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 2
          },
          "launcher": "kale"
        },
        {
          "id": "claude-0-3",
          "appId": "claude",
          "label": "Claude",
          "iconUrl": "https://www.google.com/s2/favicons?domain=claude.ai&sz=128",
          "color": "#c96442",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 3
          },
          "launcher": "kale"
        },
        {
          "id": "openrouter-0-4",
          "appId": "openrouter",
          "label": "OpenRouter",
          "iconUrl": "https://www.google.com/s2/favicons?domain=openrouter.ai&sz=128",
          "color": "#6467f2",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 4
          },
          "launcher": "kale"
        },
        {
          "id": "vscode-0-5",
          "appId": "vscode",
          "label": "VS Code",
          "iconUrl": "https://www.google.com/s2/favicons?domain=code.visualstudio.com&sz=128",
          "color": "#0e7fd6",
          "x": 0,
          "y": 0,
          "cell": {
            "col": 0,
            "row": 5
          }
        }
      ],
      "grid": true
    }
  }
};
