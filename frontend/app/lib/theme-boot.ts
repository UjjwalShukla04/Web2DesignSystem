// Shared by the server layout and the client theme hook (so no "use client" here:
// a server component importing from a client module gets a reference, not the value).

export const THEME_KEY = "w2c-theme";

/** Inline script for <head>: applies the saved theme before the page is painted. */
export const THEME_BOOT_SCRIPT = `(function(){try{var c=localStorage.getItem("${THEME_KEY}")||"system";var d=c==="dark"||(c==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);document.documentElement.style.colorScheme=d?"dark":"light";}catch(e){}})();`;
