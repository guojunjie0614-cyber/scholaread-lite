"""Local pix2tex worker. stdin/stdout are a bounded JSONL protocol; diagnostics use stderr."""
import argparse
import base64
import contextlib
import io
import json
import os
from pathlib import Path
import sys

PROJECT_DIR = Path(__file__).resolve().parent.parent
MODEL_DIR = PROJECT_DIR / ".models" / "formula-ocr"
CHECKPOINT_RELEASE = "https://github.com/lukas-blecher/LaTeX-OCR/releases/download/v0.0.1"
MAX_BYTES = 12 * 1024 * 1024
MAX_PIXELS = 12_000_000


def setup():
    import requests

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    for name in ("weights.pth", "image_resizer.pth"):
        destination = MODEL_DIR / name
        if destination.exists() and destination.stat().st_size > 1_000_000:
            continue
        temporary = destination.with_suffix(".download")
        print(f"Downloading official pix2tex v0.0.1 checkpoint: {name}", file=sys.stderr)
        try:
            with requests.get(f"{CHECKPOINT_RELEASE}/{name}", stream=True, timeout=(30, 120)) as response:
                response.raise_for_status()
                with temporary.open("wb") as output:
                    for chunk in response.iter_content(1024 * 1024):
                        output.write(chunk)
            if temporary.stat().st_size < 1_000_000:
                raise ValueError(f"Incomplete checkpoint: {name}")
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)
    load_model()
    print("Local formula OCR is ready.", file=sys.stderr)


def load_model():
    for name in ("weights.pth", "image_resizer.pth"):
        if not (MODEL_DIR / name).is_file():
            raise RuntimeError("公式模型未安装，请运行 sh scripts/setup-formula-ocr.sh")
    # Prevent library updates/downloads during recognition. Setup is the only network path.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["NO_ALBUMENTATIONS_UPDATE"] = "1"
    os.environ["TORCH_FORCE_WEIGHTS_ONLY_LOAD"] = "1"
    with contextlib.redirect_stdout(sys.stderr):
        import torch
        import pix2tex
        import pix2tex.cli as cli
        from munch import Munch

        # pix2tex's convenience API otherwise copies every prediction to the OS clipboard.
        cli.clipboard.copy = lambda _text: None
        torch.set_num_threads(min(4, os.cpu_count() or 1))
        model = cli.LatexOCR(Munch({
            "config": str(Path(pix2tex.__file__).parent / "model/settings/config.yaml"),
            "checkpoint": str(MODEL_DIR / "weights.pth"),
            "no_cuda": True,
            "no_resize": False,
        }))
        model.args.temperature = 0.0001
    return model


def recognize(model, encoded):
    from PIL import Image
    import torch

    if not isinstance(encoded, str) or len(encoded) > ((MAX_BYTES + 2) // 3) * 4:
        raise ValueError("公式图片超过 12 MB")
    data = base64.b64decode(encoded, validate=True)
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("公式识别仅支持 PNG")
    with Image.open(io.BytesIO(data)) as image:
        if image.width * image.height > MAX_PIXELS:
            raise ValueError("公式图片超过 1200 万像素")
        image.load()
        # Flatten transparent crops onto white rather than interpreting alpha as black ink.
        rgba = image.convert("RGBA")
        background = Image.new("RGBA", rgba.size, "white")
        background.alpha_composite(rgba)
        with contextlib.redirect_stdout(sys.stderr), torch.inference_mode():
            torch.manual_seed(0)
            latex = model(background.convert("RGB")).strip()
    if not latex:
        raise ValueError("未识别出公式，请检查裁剪区域")
    return latex


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--setup", action="store_true")
    args = parser.parse_args()
    if args.setup:
        setup()
        return
    model = load_model()
    print(json.dumps({"ready": True}), flush=True)
    while True:
        line = sys.stdin.readline(18 * 1024 * 1024)
        if not line:
            return
        if not line.endswith("\n"):
            raise ValueError("公式请求超过大小上限")
        request_id = None
        try:
            request = json.loads(line)
            request_id = request["id"]
            latex = recognize(model, request["png"])
            result = {"id": request_id, "latex": latex, "engine": "pix2tex"}
        except Exception as error:
            result = {"id": request_id, "error": str(error)}
        print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
