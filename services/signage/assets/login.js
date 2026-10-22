"use strict";

const form = document.getElementById("login-form");
const passwordInput = document.getElementById("password");
const submitButton = form.querySelector("button");
const message = document.getElementById("login-message");
const requestedDestinations = new URL(window.location.href).searchParams.getAll("next");
const nextPage = requestedDestinations.length === 1 &&
  /^(?:history\.html|downloads\.html|proposals\.html(?:\?offer=[a-f0-9]{32})?|proposals\/[a-f0-9]{32}\/(?:presentation|technical|compact)\.pdf|calibrator\.html(?:\?(?:restoreJob=[a-zA-Z0-9_-]{16,80}|restoreProject=[a-zA-Z0-9_-]{16,96}|newProject=1))?)$/.test(requestedDestinations[0])
  ? requestedDestinations[0] : "calibrator.html";

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (submitButton.disabled) return;
  submitButton.disabled = true;
  message.textContent = "Проверяем пароль…";
  try {
    const response = await fetch(new URL("auth/login", window.location.href), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: passwordInput.value }),
    });
    const result = await response.json();
    passwordInput.value = "";
    if (!response.ok) {
      message.textContent = result.error || "Не удалось войти.";
      passwordInput.focus();
      return;
    }
    window.location.replace(new URL(nextPage, window.location.href));
  } catch (_) {
    message.textContent = "Сервер недоступен. Проверьте соединение и повторите вход.";
  } finally {
    submitButton.disabled = false;
  }
});
