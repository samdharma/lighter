import { render } from "preact";
import { App } from "./app";
import "./styles.css";

const root = document.querySelector("#app");
if (root) render(<App />, root);
