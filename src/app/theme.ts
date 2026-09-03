import { createTheme } from "@mantine/core";

export const theme = createTheme({
  primaryColor: "signal",
  primaryShade: 6,
  defaultRadius: 2,
  fontFamily: 'Bahnschrift, "Segoe UI Variable", "Segoe UI", sans-serif',
  fontFamilyMonospace: 'Consolas, "Cascadia Mono", monospace',
  headings: {
    fontFamily: 'Bahnschrift, "Segoe UI Variable", "Segoe UI", sans-serif',
    fontWeight: "650",
  },
  colors: {
    signal: [
      "#f8ffe1",
      "#efffc0",
      "#e7ff96",
      "#deff67",
      "#d8ff45",
      "#d4ff2f",
      "#c3ed1f",
      "#a7cc13",
      "#8cad08",
      "#738f00",
    ],
  },
  components: {
    Button: { defaultProps: { radius: 2 } },
    TextInput: { defaultProps: { radius: 2 } },
    Textarea: { defaultProps: { radius: 2 } },
    Select: { defaultProps: { radius: 2 } },
    NumberInput: { defaultProps: { radius: 2 } },
    Modal: { defaultProps: { radius: 2, centered: true } },
    Drawer: { defaultProps: { radius: 0 } },
  },
});
