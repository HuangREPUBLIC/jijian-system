"use strict";
// 公司名 / 应用名 / logo，以及全站用的 SVG 图标。改 logo 时 index.html 启动页和 app-icon.svg 一起改。

const COMPANY_NAME = "惠锦制衣有限公司";
const APP_NAME = "计件跟踪";
const APP_LOGO = `
  <svg viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs>
      <linearGradient id="lg-bg" x1="60" y1="30" x2="440" y2="490" gradientUnits="userSpaceOnUse">
        <stop stop-color="#8E63E6"/><stop offset=".55" stop-color="#6A3FC1"/><stop offset="1" stop-color="#422384"/>
      </linearGradient>
      <linearGradient id="lg-gloss" x1="90" y1="60" x2="300" y2="300" gradientUnits="userSpaceOnUse">
        <stop stop-color="#FFFFFF" stop-opacity=".22"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <rect width="512" height="512" rx="116" fill="url(#lg-bg)"/>
    <path d="M116 0h280a116 116 0 0 1 116 116v70C420 96 300 40 176 40 152 40 128 42 106 46A116 116 0 0 1 116 0Z" fill="url(#lg-gloss)"/>
    <path d="M174 92H338A24 24 0 0 1 362 116V282H150V116A24 24 0 0 1 174 92Z" fill="#FFFFFF"/>
    <rect x="202" y="133" width="108" height="108" rx="16" stroke="#6A3FC1" stroke-width="22"/>
    <rect x="237" y="168" width="38" height="38" rx="6" fill="#6A3FC1"/>
    <path d="M150 316H362V396A24 24 0 0 1 338 420H174A24 24 0 0 1 150 396Z" fill="#FFFFFF" transform="rotate(9 256 368)"/>
  </svg>`;

// 工具格子图标：统一的线条图标，用 currentColor 以便跟主题色走
const ICONS = {
  employees: `<circle cx="12" cy="8" r="3.2"/><path d="M5 20c0-3.8 3.1-6.5 7-6.5s7 2.7 7 6.5"/>`,
  processes: `<circle cx="5" cy="6" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="18" r="2"/><path d="M6.8 7.6l3.4 3M13.8 13.6l3.4 3"/>`,
  styles: `<path d="M8.5 4l3.5 2 3.5-2 3 3-2 2v11H7.5V9l-2-2z"/>`,
  attendance: `<rect x="3.5" y="5" width="17" height="15" rx="2.2"/><path d="M3.5 9.5h17M8 3v3M16 3v3"/><path d="M9 14l2 2 4-4.3"/>`,
  efficiency: `<path d="M4 20V13M10 20V8M16 20V11M20 20V4"/><path d="M4 20.3h16" stroke-width="1.4"/>`,
  cutting: `<path d="M12 3.2l7.6 4.3v9L12 20.8l-7.6-4.3v-9L12 3.2z"/><path d="M4.5 7.6L12 12l7.6-4.4M12 12v8.6"/>`,
  payroll: `<circle cx="12" cy="12" r="8"/><path d="M9 8.3l3 4 3-4M12 12v5.3M9.5 13.6h5M9.5 15.6h5"/>`,
  scanlog: `<path d="M4 8V5.3A1.3 1.3 0 015.3 4H8M20 8V5.3A1.3 1.3 0 0018.7 4H16M4 16v2.7A1.3 1.3 0 005.3 20H8M20 16v2.7a1.3 1.3 0 01-1.3 1.3H16"/><path d="M4 12h16" stroke-dasharray="1.6 2.2"/>`,
  operations: `<circle cx="12" cy="13" r="7.6"/><path d="M12 9v4.3l3 1.8"/><path d="M6.2 4.3L4.4 6M17.8 4.3L19.6 6"/>`,
  admin: `<circle cx="12" cy="12" r="3"/><path d="M19.4 14a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V20a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H4a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H10a1.6 1.6 0 0 0 1-1.5V4a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V10a1.6 1.6 0 0 0 1.5 1H20a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>`,
  home: `<path d="M4 10.5 12 4l8 6.5"/><path d="M6 10v9.2a.8.8 0 0 0 .8.8h10.4a.8.8 0 0 0 .8-.8V10"/>`,
  scan: `<path d="M4 8V5.3A1.3 1.3 0 015.3 4H8M20 8V5.3A1.3 1.3 0 0018.7 4H16M4 16v2.7A1.3 1.3 0 005.3 20H8M20 16v2.7a1.3 1.3 0 01-1.3 1.3H16"/><path d="M8 12h8"/>`,
  mine: `<circle cx="12" cy="8" r="3.6"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/>`,
  bell: `<path d="M6 9.5a6 6 0 0 1 12 0c0 4 1.4 5.6 1.4 5.6H4.6S6 13.5 6 9.5Z"/><path d="M10 19a2 2 0 0 0 4 0"/>`,
  trash: `<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v5M14 11v5"/>`,
  plus: `<path d="M12 5v14M5 12h14"/>`,
  close: `<path d="M6 6l12 12M18 6L6 18"/>`,
  search: `<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>`,
  camera: `<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.4-2h6.2l1.4 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="13" r="3.5"/>`,
  image: `<rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><circle cx="9" cy="10" r="1.7"/><path d="M4 17l4.8-4.6 3.4 3.2 2.6-2.4L20 17.6"/>`,
  torch: `<path d="M8 3h8v4l-2 3v10h-4V10L8 7z"/><path d="M8 7h8"/>`,
  inbox: `<path d="M4 13l2.2-7.2A1.5 1.5 0 0 1 7.6 4.7h8.8a1.5 1.5 0 0 1 1.4 1.1L20 13v5.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z"/><path d="M4 13h4.5l1 2h5l1-2H20"/>`,
  check: `<path d="M5 12.5l4.5 4.5L19 7.5"/>`,
  refresh: `<path d="M19 12a7 7 0 1 1-2.05-4.95"/><path d="M19 4.5V8h-3.5"/>`,
};
const icon = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k]}</svg>`;
