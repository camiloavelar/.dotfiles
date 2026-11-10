import { View, div } from "gpui-kit";

// Holds the frames the simulator mod writes; Herdr only refreshes images in
// folders that are mods, so this folder needs a main.js. It shows nothing.
export default class SimulatorScreen extends View {
  render() {
    return div();
  }
}
