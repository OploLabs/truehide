const themeToggle = document.querySelector("#themeToggle");

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("truehide-theme", theme);
}

setTheme(
  localStorage.getItem("truehide-theme") ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
);

themeToggle.addEventListener("click", () => {
  setTheme(
    document.documentElement.dataset.theme === "dark" ? "light" : "dark",
  );
});

document.querySelector("#year").textContent = new Date().getFullYear();
