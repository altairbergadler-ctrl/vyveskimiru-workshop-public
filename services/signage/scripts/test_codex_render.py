"""Bridge contract tests. All subprocesses are mocked; no inference/paid calls."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest import mock

from PIL import Image

import codex_render as app


class ConnectionTests(unittest.TestCase):
    def setUp(self):
        app._STATUS_CACHE = None
        self.cli = mock.patch.object(app, "_cli_path", return_value="codex.exe")
        self.cli.start()
        self.addCleanup(self.cli.stop)

    def test_chatgpt_status_is_cached_safe_and_returns_copies(self):
        run = subprocess.CompletedProcess([], 0, "", "Logged in using ChatGPT\n")
        with mock.patch.object(app.subprocess, "run", return_value=run) as call:
            first = app.connection_status()
            self.assertTrue(first["configured"])
            first["configured"] = False
            self.assertTrue(app.connection_status()["configured"])
            self.assertEqual(call.call_count, 1)
            self.assertEqual(call.call_args.args[0], ["codex.exe", "login", "status"])
            self.assertFalse(call.call_args.kwargs["shell"])

    def test_api_login_and_unrecognised_or_failed_login_are_not_subscription(self):
        for code, text in ((0, "Logged in using an API key: sensitive-secret"),
                           (1, "Logged in using ChatGPT"), (0, "sensitive-secret")):
            app._STATUS_CACHE = None
            with mock.patch.object(app.subprocess, "run", return_value=subprocess.CompletedProcess([], code, text, "")):
                status = app.connection_status()
            self.assertFalse(status["configured"])
            self.assertNotIn("sensitive-secret", status["connection_message"])

    def test_missing_cli_and_login_timeout_are_safe(self):
        with mock.patch.object(app, "_cli_path", return_value=None), mock.patch.object(app.subprocess, "run") as run:
            self.assertFalse(app.connection_status()["configured"])
            run.assert_not_called()
        app._STATUS_CACHE = None
        with mock.patch.object(app.subprocess, "run", side_effect=subprocess.TimeoutExpired("secret", 15)):
            status = app.connection_status()
        self.assertFalse(status["configured"])
        self.assertNotIn("secret", status["connection_message"])

    def test_login_child_removes_api_keys_case_insensitively(self):
        env = {"OPENAI_API_KEY": "a", "codex_api_key": "b", "Unrelated": "kept"}
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(app.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "Logged in using ChatGPT", "")) as run:
            before = dict(os.environ)
            app.connection_status()
            child = run.call_args.kwargs["env"]
            self.assertEqual({key.upper(): value for key, value in child.items()}, {"UNRELATED": "kept"})
            self.assertEqual(dict(os.environ), before)


class GenerationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.folder = self.root / "job"
        self.folder.mkdir()
        self.canvas = self.folder / "canvas.png"
        self.guide = self.folder / "guide.png"
        Image.new("RGB", (80, 64), (20, 80, 140)).save(self.canvas)
        Image.new("RGB", (80, 64), (0, 100, 200)).save(self.guide)
        self.sources = (self.canvas.read_bytes(), self.guide.read_bytes())
        for target, value in (("_cli_path", "codex.exe"),
                              ("connection_status", {"configured": True, "connection_message": "Connected"})):
            patch = mock.patch.object(app, target, return_value=value)
            patch.start()
            self.addCleanup(patch.stop)

    def generate(self, progress=None):
        return app.generate(self.folder, "ЦВЕТЫ, ночь, подсветка", self.canvas, self.guide, on_progress=progress)

    def write_response(self, response):
        (self.folder / app._FINAL_NAME).write_text(json.dumps(response), encoding="utf-8")

    def success(self, *args, **kwargs):
        Image.new("RGBA", (112, 96), (30, 60, 90, 255)).save(self.folder / "generated.png")
        self.write_response({"status": "complete", "image_path": "generated.png", "error": None})
        return subprocess.CompletedProcess(args[0], 0)

    def test_success_uses_one_cli_call_with_safe_env_flags_and_unmodified_original(self):
        progress = []
        original_env = {"OPENAI_API_KEY": "secret-1", "Codex_API_Key": "secret-2", "OTHER": "keep"}
        with mock.patch.dict(os.environ, original_env, clear=True), mock.patch.object(app.subprocess, "run", side_effect=self.success) as run:
            before = dict(os.environ)
            result = self.generate(progress.append)
            self.assertEqual(dict(os.environ), before)
        self.assertEqual(result.mode, "RGB")
        self.assertEqual(result.size, (112, 96))
        self.assertEqual(result.getpixel((0, 0)), (30, 60, 90))
        self.assertEqual(run.call_count, 1)
        command = run.call_args.args[0]
        self.assertIsInstance(command, list)
        for flag in ("--no-daemon", "exec", "--ephemeral", "--skip-git-repo-check", "--json", "--output-schema", "-o"):
            self.assertIn(flag, command)
        self.assertEqual(command[command.index("-s") + 1], "workspace-write")
        self.assertEqual(command[command.index("-a") + 1], "never")
        self.assertIn('model_provider="openai"', command)
        self.assertEqual(command[command.index("-C") + 1], str(self.folder.resolve()))
        self.assertEqual(command[-1], "-")
        self.assertFalse(any("dangerously" in arg or "ignore-rules" in arg for arg in command))
        options = run.call_args.kwargs
        self.assertEqual(options["env"], {"OTHER": "keep"})
        self.assertFalse(options["shell"])
        self.assertEqual(options["stdout"], subprocess.DEVNULL)
        self.assertEqual(options["stderr"], subprocess.DEVNULL)
        self.assertLessEqual(options["timeout"], 900)
        self.assertIn("EXACTLY ONE", options["input"])
        self.assertIn("image_gen__imagegen", options["input"])
        self.assertIn("view_image", options["input"])
        self.assertIn("GEOMETRY LOCK", options["input"])
        self.assertNotIn("secret-1", options["input"])
        self.assertEqual((self.canvas.read_bytes(), self.guide.read_bytes()), self.sources)
        self.assertEqual(len(progress), 2)
        schema = json.loads((self.folder / app._SCHEMA_NAME).read_text(encoding="utf-8"))
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(set(schema["required"]), {"status", "image_path", "error"})

    def test_no_login_does_not_launch_or_create_artifacts(self):
        with mock.patch.object(app, "connection_status", return_value={"configured": False, "connection_message": "Войдите через ChatGPT."}), mock.patch.object(app.subprocess, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "Войдите"):
                self.generate()
            run.assert_not_called()
        self.assertFalse((self.folder / app._SCHEMA_NAME).exists())

    def test_timeout_and_process_failure_never_retry_or_expose_error(self):
        with mock.patch.object(app.subprocess, "run", side_effect=subprocess.TimeoutExpired(["secret"], 900, output="secret-output", stderr="secret-error")) as run:
            with self.assertRaisesRegex(RuntimeError, "Исход генерации неизвестен") as caught:
                self.generate()
        self.assertEqual(run.call_count, 1)
        self.assertNotIn("secret", str(caught.exception))
        # An old timeout result cannot be retried in the same job directory.
        with mock.patch.object(app.subprocess, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "новая папка"):
                self.generate()
            run.assert_not_called()

    def test_nonzero_exit_is_not_success_even_if_files_exist(self):
        def failed(*args, **kwargs):
            self.success(*args, **kwargs)
            return subprocess.CompletedProcess(args[0], 1, "private", "secret")
        with mock.patch.object(app.subprocess, "run", side_effect=failed) as run:
            with self.assertRaisesRegex(RuntimeError, "Исход генерации неизвестен") as caught:
                self.generate()
        self.assertEqual(run.call_count, 1)
        self.assertNotIn("secret", str(caught.exception))

    def test_failed_and_unavailable_status_hide_raw_error(self):
        for status in ("failed", "unavailable"):
            with self.subTest(status=status):
                self.write_response({"status": status, "image_path": None, "error": "sk-sensitive secret image-data"})
                with self.assertRaises(RuntimeError) as caught:
                    app._load_result(self.folder / app._FINAL_NAME, self.folder.resolve())
                self.assertNotIn("sensitive", str(caught.exception))

    def test_path_escape_is_rejected_even_for_valid_png(self):
        outside = self.root / "outside.png"
        Image.new("RGB", (8, 8)).save(outside)
        for path in (str(outside), "../outside.png"):
            self.write_response({"status": "complete", "image_path": path, "error": None})
            with self.assertRaisesRegex(RuntimeError, "внутри папки"):
                app._load_result(self.folder / app._FINAL_NAME, self.folder.resolve())

    def test_claiming_an_input_as_generated_output_is_rejected(self):
        self.write_response({"status": "complete", "image_path": str(self.canvas), "error": None})
        with self.assertRaisesRegex(RuntimeError, "корректный PNG"):
            app._load_result(self.folder / app._FINAL_NAME, self.folder.resolve())

    def test_zero_exit_without_final_response_is_unknown_and_not_retried(self):
        with mock.patch.object(app.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run:
            with self.assertRaisesRegex(RuntimeError, "Исход генерации неизвестен"):
                self.generate()
        self.assertEqual(run.call_count, 1)

    def test_invalid_png_and_wrong_response_schema_are_rejected(self):
        image = self.folder / "generated.png"
        image.write_bytes(b"not a png")
        self.write_response({"status": "complete", "image_path": "generated.png", "error": None})
        with self.assertRaisesRegex(RuntimeError, "корректный PNG"):
            app._load_result(self.folder / app._FINAL_NAME, self.folder.resolve())
        Image.new("RGB", (8, 8)).save(image, format="JPEG")
        with self.assertRaisesRegex(RuntimeError, "корректный PNG"):
            app._load_result(self.folder / app._FINAL_NAME, self.folder.resolve())
        responses = [[], {"status": "complete"}, {"status": "complete", "image_path": "generated.png", "error": None, "extra": "secret"},
                     {"status": {}, "image_path": None, "error": None}]
        for response in responses:
            self.write_response(response)
            with self.assertRaises(RuntimeError):
                app._load_result(self.folder / app._FINAL_NAME, self.folder.resolve())

    def test_existing_output_and_outside_input_prevent_launch(self):
        with mock.patch.object(app.subprocess, "run") as run:
            (self.folder / "generated.png").write_bytes(b"old result")
            with self.assertRaisesRegex(RuntimeError, "новая папка"):
                self.generate()
            run.assert_not_called()
        outside = self.root / "canvas.png"
        outside.write_bytes(self.canvas.read_bytes())
        with mock.patch.object(app.subprocess, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "новая папка"):
                app.generate(self.folder, "brief", outside, self.guide)
            run.assert_not_called()

    def test_callback_exception_does_not_repeat_or_abort_completed_call(self):
        with mock.patch.object(app.subprocess, "run", side_effect=self.success) as run:
            result = self.generate(lambda _message: 1 / 0)
        self.assertEqual(result.size, (112, 96))
        self.assertEqual(run.call_count, 1)

    def test_optional_third_color_reference_is_inspected_and_passed_in_order_once(self):
        color_card = self.folder / "color-reference.png"
        Image.new("RGB", (720, 420), (255, 0, 0)).save(color_card)
        original = color_card.read_bytes()
        with mock.patch.object(app.subprocess, "run", side_effect=self.success) as run:
            result = app.generate(self.folder, "film on acrylic, front red", self.canvas, self.guide,
                                  color_reference_path=color_card)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(result.size, (112, 96))
        prompt = run.call_args.kwargs["input"]
        inputs = json.loads(prompt.split("Task data:\n", 1)[1])
        self.assertEqual(inputs["referenced_image_paths"], [str(self.canvas.resolve()), str(self.guide.resolve()), str(color_card.resolve())])
        self.assertEqual(inputs["color_reference"], str(color_card.resolve()))
        self.assertIn("Inspect ALL supplied local reference images", prompt)
        self.assertIn("NEVER paste or render the card", prompt)
        self.assertEqual(color_card.read_bytes(), original)

    def test_optional_color_reference_must_be_an_existing_local_job_file(self):
        for path in (self.folder / "missing.png", self.root / "outside-card.png"):
            if path.name == "outside-card.png":
                Image.new("RGB", (8, 8)).save(path)
            with mock.patch.object(app.subprocess, "run") as run:
                with self.assertRaisesRegex(RuntimeError, "Генерация не запускалась"):
                    app.generate(self.folder, "film", self.canvas, self.guide, color_reference_path=path)
                run.assert_not_called()

    def test_custom_scene_references_replace_defaults_in_exact_order(self):
        product = self.folder / "product-neutral.png"
        artwork = self.folder / "exact-artwork.png"
        Image.new("RGBA", (32, 24), (30, 60, 90, 0)).save(product)
        Image.new("RGBA", (32, 24), (255, 255, 255, 255)).save(artwork)
        references = [self.canvas, self.guide, product, artwork]
        originals = [path.read_bytes() for path in references]
        with mock.patch.object(app.subprocess, "run", side_effect=self.success) as run:
            result = app.generate(self.folder, "Install supplied neutral product using exact overlay",
                                  self.canvas, self.guide, reference_image_paths=references)
        self.assertEqual(run.call_count, 1)
        prompt = run.call_args.kwargs["input"]
        data = json.loads(prompt.split("Task data:\n", 1)[1])
        self.assertEqual(data["referenced_image_paths"], [str(path.resolve()) for path in references])
        self.assertEqual(data["render_mode"], "scene_edit")
        self.assertIs(data["transparent_background"], False)
        self.assertEqual(data["color_reference"], None)
        self.assertIn("do not assume the third", prompt)
        self.assertNotIn("If supplied, the THIRD reference", prompt)
        self.assertIn("Do not reorder, add or drop references", prompt)
        self.assertEqual(result.mode, "RGB")
        self.assertEqual([path.read_bytes() for path in references], originals)

    def test_single_neutral_reference_requests_transparency_and_keeps_alpha(self):
        def transparent(*args, **kwargs):
            Image.new("RGBA", (112, 96), (30, 60, 90, 0)).save(self.folder / "generated.png")
            self.write_response({"status": "complete", "image_path": "generated.png", "error": None})
            return subprocess.CompletedProcess(args[0], 0)
        with mock.patch.object(app.subprocess, "run", side_effect=transparent) as run:
            result = app.generate(self.folder, "Neutral product using exact contours and dimensions",
                                  self.guide, self.guide, reference_image_paths=[self.guide],
                                  transparent_background=True)
        self.assertEqual(run.call_count, 1)
        prompt = run.call_args.kwargs["input"]
        data = json.loads(prompt.split("Task data:\n", 1)[1])
        self.assertEqual(data["referenced_image_paths"], [str(self.guide.resolve())])
        self.assertIs(data["transparent_background"], True)
        self.assertEqual(data["render_mode"], "neutral_product")
        self.assertIn("even neutral illumination", prompt)
        self.assertIn("must never replace the authoritative project or production geometry", prompt)
        self.assertNotIn("is the photograph to edit", prompt)
        self.assertEqual(result.mode, "RGBA")
        self.assertEqual(result.getpixel((0, 0)), (30, 60, 90, 0))

    def test_legacy_references_and_opaque_default_still_use_canvas_guide_color_card(self):
        card = self.folder / "color-reference.png"
        Image.new("RGB", (8, 8), "red").save(card)
        with mock.patch.object(app.subprocess, "run", side_effect=self.success) as run:
            result = app.generate(self.folder, "Legacy scene edit", self.canvas, self.guide,
                                  color_reference_path=card)
        prompt = run.call_args.kwargs["input"]
        data = json.loads(prompt.split("Task data:\n", 1)[1])
        self.assertEqual(data["referenced_image_paths"], [str(path.resolve()) for path in (self.canvas, self.guide, card)])
        self.assertIs(data["transparent_background"], False)
        self.assertIn("If supplied, the THIRD reference", prompt)
        self.assertIn("NEVER paste or render the card", prompt)
        self.assertEqual(result.mode, "RGB")

    def test_placed_fronts_are_preserved_by_worker_instead_of_removed_as_old_signage(self):
        references = [self.canvas, self.guide]
        with mock.patch.object(app.subprocess, "run", side_effect=self.success) as run:
            app.generate(self.folder, "Finish the new placed sign in place", self.canvas, self.guide,
                         reference_image_paths=references, preserve_placed_artwork=True)
        prompt = run.call_args.kwargs["input"]
        data = json.loads(prompt.split("Task data:\n", 1)[1])
        self.assertIs(data["preserve_placed_artwork"], True)
        self.assertEqual(data["referenced_image_paths"], [str(path.resolve()) for path in references])
        self.assertIn("do not move, resize, recenter", prompt)
        self.assertIn("do not mistake the new placed fronts for obsolete signage", prompt)
        self.assertNotIn("Remove the existing sign/object", prompt)
        self.assertEqual(run.call_count, 1)

    def test_placed_front_flag_is_strict_and_requires_an_opaque_custom_reference_edit(self):
        for options in ({"preserve_placed_artwork": "true"}, {"preserve_placed_artwork": True},
                        {"preserve_placed_artwork": True, "transparent_background": True,
                         "reference_image_paths": [self.guide]}):
            with self.subTest(options=options), mock.patch.object(app.subprocess, "run") as run:
                with self.assertRaisesRegex(RuntimeError, "Генерация не запускалась"):
                    app.generate(self.folder, "Preserve new fronts", self.canvas, self.guide, **options)
                run.assert_not_called()
                self.assertFalse((self.folder / app._SCHEMA_NAME).exists())

    def test_background_pass_forbids_new_signs_even_at_night(self):
        with mock.patch.object(app.subprocess, "run", side_effect=self.success) as run:
            app.generate(self.folder, "Clean wall at night", self.canvas, self.guide,
                         reference_image_paths=[self.canvas, self.guide], background_only=True)
        prompt = run.call_args.kwargs["input"]
        self.assertIn("MANDATORY BACKGROUND-ONLY EDIT", prompt)
        self.assertIn("even at night", prompt)
        self.assertNotIn("night requires the new sign lights ON", prompt)
        self.assertEqual(run.call_count, 1)

    def test_background_flag_rejects_conflicting_modes_before_launch(self):
        for options in ({"background_only": 1}, {"background_only": True, "transparent_background": True},
                        {"background_only": True, "preserve_placed_artwork": True}):
            with self.subTest(options=options), mock.patch.object(app.subprocess, "run") as run:
                with self.assertRaisesRegex(RuntimeError, "Генерация не запускалась"):
                    app.generate(self.folder, "Clean wall", self.canvas, self.guide,
                                 reference_image_paths=[self.canvas, self.guide], **options)
                run.assert_not_called()

    def test_custom_reference_count_and_container_are_strict(self):
        for references in ([], [self.canvas] * 9, str(self.canvas), iter([self.canvas]), 1, False):
            with self.subTest(references=type(references).__name__), mock.patch.object(app.subprocess, "run") as run:
                with self.assertRaisesRegex(RuntimeError, "Генерация не запускалась"):
                    app.generate(self.folder, "Neutral", self.canvas, self.guide,
                                 reference_image_paths=references)
                run.assert_not_called()
                self.assertFalse((self.folder / app._SCHEMA_NAME).exists())

    def test_eight_ordered_custom_references_are_allowed(self):
        references = []
        for index in range(8):
            path = self.folder / f"artwork-{index:03d}.png"
            Image.new("RGBA", (8, 8), (index, 10, 20, 255)).save(path)
            references.append(path)
        with mock.patch.object(app.subprocess, "run", side_effect=self.success) as run:
            app.generate(self.folder, "Neutral", self.canvas, self.guide,
                         reference_image_paths=references, transparent_background=True)
        data = json.loads(run.call_args.kwargs["input"].split("Task data:\n", 1)[1])
        self.assertEqual(data["referenced_image_paths"], [str(path.resolve()) for path in references])

    def test_transparency_flag_requires_a_boolean_before_launch_or_artifacts(self):
        for flag in (None, 0, 1, "false", "true", [], {}):
            with self.subTest(flag=flag), mock.patch.object(app.subprocess, "run") as run:
                with self.assertRaisesRegex(RuntimeError, "Генерация не запускалась"):
                    app.generate(self.folder, "Neutral", self.canvas, self.guide,
                                 reference_image_paths=[self.guide], transparent_background=flag)
                run.assert_not_called()
                self.assertFalse((self.folder / app._SCHEMA_NAME).exists())

    def test_custom_reference_files_must_be_real_valid_job_pngs(self):
        outside = self.root / "outside.png"
        outside.write_bytes(self.canvas.read_bytes())
        jpeg = self.folder / "jpeg.png"
        Image.new("RGB", (8, 8)).save(jpeg, format="JPEG")
        renamed = self.folder / "png.jpg"
        renamed.write_bytes(self.canvas.read_bytes())
        corrupt = self.folder / "corrupt.png"
        corrupt.write_bytes(b"not a PNG")
        directory = self.folder / "directory.png"
        directory.mkdir()
        animation = self.folder / "animated.png"
        frames = [Image.new("RGB", (8, 8), color) for color in ("red", "blue")]
        frames[0].save(animation, save_all=True, append_images=frames[1:])
        for path in (outside, self.folder / "missing.png", jpeg, renamed, corrupt, directory, animation):
            with self.subTest(path=path.name), mock.patch.object(app.subprocess, "run") as run:
                with self.assertRaisesRegex(RuntimeError, "Генерация не запускалась"):
                    app.generate(self.folder, "Neutral", self.canvas, self.guide,
                                 reference_image_paths=[path])
                run.assert_not_called()
                self.assertFalse((self.folder / app._SCHEMA_NAME).exists())

    def test_custom_reference_canonical_escape_is_rejected_without_symlink_privileges(self):
        outside = self.root / "outside.png"
        outside.write_bytes(self.canvas.read_bytes())
        alias = self.folder / "junction" / "reference.png"
        real_resolve = app.Path.resolve
        def resolve(path, *args, **kwargs):
            if path == alias:
                return outside.resolve()
            return real_resolve(path, *args, **kwargs)
        with mock.patch.object(app.Path, "resolve", autospec=True, side_effect=resolve), mock.patch.object(app.subprocess, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "Генерация не запускалась"):
                app.generate(self.folder, "Neutral", self.canvas, self.guide,
                             reference_image_paths=[alias])
            run.assert_not_called()
        self.assertFalse((self.folder / app._SCHEMA_NAME).exists())

    def test_custom_reference_symlink_is_rejected(self):
        link = self.folder / "linked-reference.png"
        try:
            link.symlink_to(self.canvas)
        except OSError:
            self.skipTest("File symlinks unavailable for this test account")
        with mock.patch.object(app.subprocess, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "Генерация не запускалась"):
                app.generate(self.folder, "Neutral", self.canvas, self.guide,
                             reference_image_paths=[link])
            run.assert_not_called()

    def native_png(self):
        root = self.root / "native-output"
        root.mkdir(exist_ok=True)
        source = root / "returned-image.png"
        Image.new("RGBA", (112, 96), (30, 60, 90, 255)).save(source)
        return root, source

    def test_native_result_is_copied_by_host_unchanged_without_worker_shell_or_second_call(self):
        native_root, source = self.native_png()
        original = source.read_bytes()
        def completed(*args, **kwargs):
            self.write_response({"status": "complete", "image_path": str(source), "error": None})
            return subprocess.CompletedProcess(args[0], 0)
        with mock.patch.object(app, "_native_output_root", return_value=native_root.resolve()), mock.patch.object(app.subprocess, "run", side_effect=completed) as run:
            image = self.generate()
        self.assertEqual(run.call_count, 1)
        self.assertIn("Do NOT invoke shell or local execution tools", run.call_args.kwargs["input"])
        self.assertIn("EXACT absolute local PNG path returned", run.call_args.kwargs["input"])
        self.assertEqual(image.getpixel((0, 0)), (30, 60, 90))
        self.assertEqual((self.folder / "generated.png").read_bytes(), original)
        self.assertEqual(source.read_bytes(), original)
        receipt = json.loads((self.folder / "image-transfer.json").read_text(encoding="utf-8"))
        self.assertEqual(receipt["source_path"], str(source.resolve()))
        self.assertEqual(receipt["source_sha256"], hashlib.sha256(original).hexdigest())
        self.assertEqual(receipt["source_sha256"], receipt["copied_sha256"])
        self.assertFalse(receipt["regenerated"])
        self.assertEqual(receipt["provenance"], "worker_reported_native_imagegen_path")

    def test_native_transparent_result_keeps_alpha_and_exact_original_bytes(self):
        native_root, source = self.native_png()
        Image.new("RGBA", (112, 96), (30, 60, 90, 23)).save(source)
        original = source.read_bytes()
        def completed(*args, **kwargs):
            self.write_response({"status": "complete", "image_path": str(source), "error": None})
            return subprocess.CompletedProcess(args[0], 0)
        with mock.patch.object(app, "_native_output_root", return_value=native_root.resolve()), mock.patch.object(app.subprocess, "run", side_effect=completed) as run:
            result = app.generate(self.folder, "Neutral product", self.guide, self.guide,
                                  reference_image_paths=[self.guide], transparent_background=True)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(result.mode, "RGBA")
        self.assertEqual(result.getpixel((0, 0)), (30, 60, 90, 23))
        self.assertEqual((self.folder / "generated.png").read_bytes(), original)
        self.assertEqual(source.read_bytes(), original)

    def test_native_result_requires_invocation_time_not_just_an_outside_path(self):
        native_root, source = self.native_png()
        self.write_response({"status": "complete", "image_path": str(source), "error": None})
        with mock.patch.object(app, "_native_output_root", return_value=native_root.resolve()):
            with self.assertRaises(RuntimeError):
                app._load_result(self.folder / app._FINAL_NAME, self.folder.resolve())
        self.assertFalse((self.folder / "generated.png").exists())

    def test_native_result_rejects_stale_and_future_files(self):
        native_root, source = self.native_png()
        started = time.time()
        for timestamp in (started - 60, started + 60):
            os.utime(source, (timestamp, timestamp))
            self.write_response({"status": "complete", "image_path": str(source), "error": None})
            with mock.patch.object(app, "_native_output_root", return_value=native_root.resolve()):
                with self.assertRaisesRegex(RuntimeError, "проверку пути, времени или формата"):
                    app._load_result(self.folder / app._FINAL_NAME, self.folder.resolve(), started_at=started)
        self.assertFalse((self.folder / "generated.png").exists())

    def test_native_result_rejects_arbitrary_outside_and_relative_paths(self):
        native_root, source = self.native_png()
        outside = self.root / "outside.png"
        outside.write_bytes(source.read_bytes())
        for candidate in (str(outside), "../native-output/returned-image.png", str(self.canvas)):
            self.write_response({"status": "complete", "image_path": candidate, "error": None})
            with mock.patch.object(app, "_native_output_root", return_value=native_root.resolve()):
                with self.assertRaises(RuntimeError):
                    app._load_result(self.folder / app._FINAL_NAME, self.folder.resolve(), started_at=time.time())
        self.assertFalse((self.folder / "generated.png").exists())

    def test_native_symlink_escape_is_rejected(self):
        native_root, source = self.native_png()
        outside = self.root / "outside.png"
        outside.write_bytes(source.read_bytes())
        link = native_root / "linked-image.png"
        try:
            link.symlink_to(outside)
        except OSError:
            self.skipTest("File symlinks unavailable for this test account")
        self.write_response({"status": "complete", "image_path": str(link), "error": None})
        with mock.patch.object(app, "_native_output_root", return_value=native_root.resolve()):
            with self.assertRaises(RuntimeError):
                app._load_result(self.folder / app._FINAL_NAME, self.folder.resolve(), started_at=time.time())
        self.assertFalse((self.folder / "generated.png").exists())

    def test_native_canonical_escape_is_rejected_without_symlink_privileges(self):
        native_root, source = self.native_png()
        outside = self.root / "outside.png"
        outside.write_bytes(source.read_bytes())
        alias = native_root / "junction" / "returned-image.png"
        real_resolve = app.Path.resolve
        def resolve(path, *args, **kwargs):
            if path == alias:
                return outside.resolve()
            return real_resolve(path, *args, **kwargs)
        with mock.patch.object(app, "_native_output_root", return_value=native_root.resolve()), mock.patch.object(app.Path, "resolve", autospec=True, side_effect=resolve):
            with self.assertRaisesRegex(RuntimeError, "проверку пути, времени или формата"):
                app._transfer_native(alias, self.folder.resolve(), time.time())
        self.assertFalse((self.folder / "generated.png").exists())

    def test_native_missing_png_reports_transfer_validation_failure(self):
        native_root, source = self.native_png()
        missing = native_root / "not-returned.png"
        self.write_response({"status": "complete", "image_path": str(missing), "error": None})
        with mock.patch.object(app, "_native_output_root", return_value=native_root.resolve()):
            with self.assertRaisesRegex(RuntimeError, "создании изображения.*проверку пути, времени или формата"):
                app._load_result(self.folder / app._FINAL_NAME, self.folder.resolve(), started_at=time.time())
        self.assertFalse((self.folder / "generated.png").exists())

    def test_native_corrupt_oversized_and_animated_pngs_are_rejected(self):
        native_root, source = self.native_png()
        valid = source.read_bytes()
        self.write_response({"status": "complete", "image_path": str(source), "error": None})
        with mock.patch.object(app, "_native_output_root", return_value=native_root.resolve()):
            source.write_bytes(b"not an image")
            with self.assertRaises(RuntimeError):
                app._load_result(self.folder / app._FINAL_NAME, self.folder.resolve(), started_at=time.time())
            source.write_bytes(valid)
            with mock.patch.object(app, "MAX_IMAGE_BYTES", 10), self.assertRaises(RuntimeError):
                app._load_result(self.folder / app._FINAL_NAME, self.folder.resolve(), started_at=time.time())
            with mock.patch.object(app, "MAX_IMAGE_PIXELS", 10), self.assertRaises(RuntimeError):
                app._load_result(self.folder / app._FINAL_NAME, self.folder.resolve(), started_at=time.time())
            frames = [Image.new("RGB", (8, 8), color) for color in ("red", "blue")]
            frames[0].save(source, save_all=True, append_images=frames[1:])
            with self.assertRaises(RuntimeError):
                app._load_result(self.folder / app._FINAL_NAME, self.folder.resolve(), started_at=time.time())
        self.assertFalse((self.folder / "generated.png").exists())

    def test_native_copy_failure_has_distinct_safe_error_and_never_overwrites(self):
        native_root, source = self.native_png()
        destination = self.folder / "generated.png"
        destination.write_bytes(b"already saved")
        self.write_response({"status": "complete", "image_path": str(source), "error": None})
        with mock.patch.object(app, "_native_output_root", return_value=native_root.resolve()), mock.patch.object(app.subprocess, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "Изображение создано.*не смог сохранить"):
                app._load_result(self.folder / app._FINAL_NAME, self.folder.resolve(), started_at=time.time())
            run.assert_not_called()
        self.assertEqual(destination.read_bytes(), b"already saved")
        self.assertFalse((self.folder / "image-transfer.json").exists())

    def test_native_missing_source_path_does_not_search_for_existing_images(self):
        native_root, source = self.native_png()
        self.write_response({"status": "complete", "image_path": None, "error": None})
        with mock.patch.object(app, "_native_output_root", return_value=native_root.resolve()), mock.patch.object(app.Path, "rglob", side_effect=AssertionError("Must not scan")):
            with self.assertRaises(RuntimeError):
                app._load_result(self.folder / app._FINAL_NAME, self.folder.resolve(), started_at=time.time())
        self.assertTrue(source.exists())
        self.assertFalse((self.folder / "generated.png").exists())


if __name__ == "__main__":
    unittest.main()
