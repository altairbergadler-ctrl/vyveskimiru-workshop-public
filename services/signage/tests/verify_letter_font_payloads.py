"""Run browser-captured font inputs through both real pipeline stages, with an injected renderer."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from PIL import Image
import render_server as app
import two_stage_letters as pipeline

folder = Path(sys.argv[1])
results = []
keys = set()
with tempfile.TemporaryDirectory(prefix="signage-font-pipeline-") as temp:
    calls = []

    def renderer(directory, prompt, canvas, guide, *, reference_image_paths=None,
                 transparent_background=False, **kwargs):
        calls.append({"prompt": prompt, "references": [path.name for path in reference_image_paths or []]})
        with Image.open(canvas) as image:
            return image.convert("RGBA" if transparent_background else "RGB")

    service = app.Service(Path(temp), renderer=renderer, status_reader=lambda: {"configured": True})
    for index, file in enumerate(sorted(folder.glob("payload-*.json"))):
        body = json.loads(file.read_text(encoding="utf8"))
        body["request_id"] = f"font-contract-{index:04d}-20261014"
        source, project, report, mode, quad, mask = app.prepare(body)
        inputs = pipeline.physical_inputs(project, report)
        original = project["products"][0]["params"]["objects"][0]
        key = pipeline.cache_key(project, report)
        assert key not in keys, "Different font/weight reused the same appearance cache"
        keys.add(key)
        prior = len(calls)
        service.submit(body)
        assert service.wait_for_workers(30)
        job = service.public(body["request_id"])
        assert job["status"] == "complete", job
        assert len(calls) == prior + 2, "Both stages must see this new font/weight"
        for call in calls[prior:]:
            assert original["font_family"] in call["prompt"]
            assert inputs["objects"][0]["artwork_sha256"] in call["prompt"]
        assert "product-guide.png" in calls[prior]["references"]
        assert "layout-guide.png" in calls[prior + 1]["references"]
        assert "product-guide.png" in calls[prior + 1]["references"]
        job_folder = Path(temp) / body["request_id"]
        saved = json.loads((job_folder / "input-project.json").read_text(encoding="utf8"))
        assert saved["products"][0]["params"]["objects"][0] == original
        spec = json.loads((job_folder / "production-spec.json").read_text(encoding="utf8"))
        assert original["font_family"] in json.dumps(spec)
        assert job["audit"]["changed_pixels_outside_edit_zone"] == 0
        results.append({"font": original["font_family"], "bold": original["font_bold"],
                        "width_cm": inputs["objects"][0]["width_cm"], "stage_calls": 2,
                        "exact_artwork_sha256": inputs["objects"][0]["artwork_sha256"],
                        "saved_input_preserved": True, "separate_cache_key": True})
    service.wait_for_workers(30)
assert len(results) == 4
result = {"passed": True, "real_ai_calls": 0, "renderer": "injected", "fonts": results}
(folder / "pipeline-result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf8")
print(json.dumps(result, ensure_ascii=False, indent=2))
