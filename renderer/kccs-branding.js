/**
 * KCCS Branding Module
 * Drop-in branding footer for all KCCS Electron apps.
 * Usage: require('./kccs-branding').inject() or import and call inject()
 */

const KCCS_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="20" height="20" style="vertical-align:middle">
  <rect x="10" y="8" width="44" height="32" rx="3" fill="#1e1e2e" stroke="#89b4fa" stroke-width="2"/>
  <rect x="14" y="12" width="36" height="24" rx="1" fill="#181825"/>
  <line x1="16" y1="20" x2="34" y2="20" stroke="#a6e3a1" stroke-width="2" stroke-linecap="round"/>
  <line x1="16" y1="25" x2="28" y2="25" stroke="#89b4fa" stroke-width="2" stroke-linecap="round"/>
  <line x1="16" y1="30" x2="40" y2="30" stroke="#f38ba8" stroke-width="2" stroke-linecap="round"/>
  <rect x="36" y="19" width="2" height="3" fill="#a6e3a1"><animate attributeName="opacity" values="1;0;1" dur="1s" repeatCount="indefinite"/></rect>
  <rect x="27" y="40" width="10" height="4" fill="#585b70"/>
  <rect x="22" y="44" width="20" height="3" rx="1" fill="#585b70"/>
  <ellipse cx="25" cy="16" rx="5" ry="3" fill="#11111b" stroke="#cdd6f4" stroke-width="1"/>
  <ellipse cx="39" cy="16" rx="5" ry="3" fill="#11111b" stroke="#cdd6f4" stroke-width="1"/>
  <line x1="30" y1="16" x2="34" y2="16" stroke="#cdd6f4" stroke-width="1"/>
  <path d="M28 18.5 Q32 21 36 18.5" fill="none" stroke="#f9e2af" stroke-width="1" stroke-linecap="round"/>
</svg>`;

const CURRENT_YEAR = new Date().getFullYear();

const BRANDING_CSS = `
.kccs-branding {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 4px 12px;
  background: rgba(17, 17, 27, 0.85);
  backdrop-filter: blur(8px);
  border-top: 1px solid rgba(137, 180, 250, 0.15);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 11px;
  color: rgba(166, 173, 200, 0.6);
  z-index: 9999;
  user-select: none;
  transition: color 0.2s ease;
  height: 24px;
  box-sizing: border-box;
}
.kccs-branding:hover {
  color: rgba(166, 173, 200, 0.9);
}
.kccs-branding a {
  color: rgba(137, 180, 250, 0.5);
  text-decoration: none;
  transition: color 0.2s ease;
}
.kccs-branding:hover a {
  color: rgba(137, 180, 250, 0.8);
}
.kccs-branding .kccs-logo {
  opacity: 0.5;
  transition: opacity 0.2s ease;
}
.kccs-branding:hover .kccs-logo {
  opacity: 0.9;
}
`;

function inject(options = {}) {
  const { paddingBottom = true } = options;

  // Add CSS
  const style = document.createElement('style');
  style.textContent = BRANDING_CSS;
  document.head.appendChild(style);

  // Add footer
  const footer = document.createElement('div');
  footer.className = 'kccs-branding';
  footer.innerHTML = `<span class="kccs-logo">${KCCS_LOGO_SVG}</span> <span>&copy; ${CURRENT_YEAR} KCCS</span> <span>&middot;</span> <a href="https://kccsonline.com" target="_blank">kccsonline.com</a>`;
  document.body.appendChild(footer);

  // Add padding to body so content doesn't hide behind footer
  if (paddingBottom) {
    document.body.style.paddingBottom = (parseInt(getComputedStyle(document.body).paddingBottom) || 0) + 28 + 'px';
  }
}

// Auto-inject if loaded as script tag
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { inject, KCCS_LOGO_SVG, BRANDING_CSS };
} else {
  // Browser context - auto inject on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => inject());
  } else {
    inject();
  }
}
