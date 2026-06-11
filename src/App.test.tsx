import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("renders the private audio upload workspace", () => {
    render(<App />);
    expect(screen.getByText("Spectra Studio")).toBeInTheDocument();
    expect(screen.getByText(/Genera un espectro/)).toBeInTheDocument();
    expect(screen.getByLabelText("Seleccionar archivo")).toHaveAttribute("type", "file");
  });

  it("shows persistent dismissible errors as toasts", async () => {
    render(<App />);
    const input = screen.getByLabelText("Seleccionar archivo");
    fireEvent.change(input, { target: { files: [new File(["text"], "notes.txt", { type: "text/plain" })] } });

    expect(await screen.findByText("Formato no compatible")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Cerrar notificación"));
    await waitFor(() => expect(screen.queryByText("Formato no compatible")).not.toBeInTheDocument());
  });
});
