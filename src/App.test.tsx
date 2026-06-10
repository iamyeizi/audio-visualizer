import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("renders the private audio upload workspace", () => {
    render(<App />);
    expect(screen.getByText("Spectra Studio")).toBeInTheDocument();
    expect(screen.getByText(/Convierte tu audio/)).toBeInTheDocument();
    expect(screen.getByLabelText("Seleccionar audio")).toHaveAttribute("type", "file");
  });
});
