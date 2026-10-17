/** Тип для типових текстових імпортів Vite: `import raw from "./x.html?raw"`. */
declare module "*.html?raw" {
  const html: string;
  export default html;
}
