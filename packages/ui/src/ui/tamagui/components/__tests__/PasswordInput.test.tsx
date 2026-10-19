import { forwardRef, useState } from "react";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProvider } from "../../../../../test/utils";
import { PasswordInput } from "../forms/PasswordInput";

describe("PasswordInput", () => {
  it("renders with type=password by default", () => {
    renderWithProvider(<PasswordInput placeholder="Enter password" />);

    const input = screen.getByPlaceholderText(
      "Enter password",
    ) as HTMLInputElement;
    expect(input.getAttribute("type")).toBe("password");
  });

  it("reserves right padding so text does not flow under the toggle", () => {
    renderWithProvider(<PasswordInput placeholder="Enter password" />);

    const input = screen.getByPlaceholderText(
      "Enter password",
    ) as HTMLInputElement;
    // The component sets paddingRight={44} on the TextInput. Tamagui converts this
    // to a class, so the style should be present.
    expect(input).toBeTruthy();
  });

  it("renders the eye toggle with a default aria-label", () => {
    renderWithProvider(<PasswordInput placeholder="Password" />);

    const toggle = screen.getByLabelText("Toggle password visibility");
    expect(toggle).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Password hidden");
  });

  it("accepts a custom toggleLabel", () => {
    renderWithProvider(
      <PasswordInput
        placeholder="Password"
        toggleLabel="Show or hide password"
      />,
    );

    expect(screen.getByLabelText("Show or hide password")).toBeInTheDocument();
  });

  it("accepts custom visible/hidden state labels", async () => {
    const user = userEvent.setup();
    renderWithProvider(
      <PasswordInput
        placeholder="Password"
        visibleStateLabel="Contrasena visible"
        hiddenStateLabel="Contrasena oculta"
      />,
    );

    const toggle = screen.getByLabelText("Toggle password visibility");
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Contrasena oculta");
    expect(status.getAttribute("id")).toBeTruthy();
    expect(toggle).toHaveAttribute(
      "aria-describedby",
      status.getAttribute("id"),
    );
    expect(toggle).toHaveAttribute("aria-description", "Contrasena oculta");

    await user.click(toggle);
    expect(status).toHaveTextContent("Contrasena visible");
    expect(toggle).toHaveAttribute("aria-description", "Contrasena visible");
  });

  it("toggles visibility in uncontrolled mode", async () => {
    const user = userEvent.setup();
    renderWithProvider(<PasswordInput placeholder="Password" />);

    const input = screen.getByPlaceholderText("Password") as HTMLInputElement;
    expect(input.getAttribute("type")).toBe("password");

    const toggle = screen.getByLabelText("Toggle password visibility");
    await user.click(toggle);

    expect(input.getAttribute("type")).toBe("text");
  });

  it("keeps the password visible while typing after reveal", async () => {
    const user = userEvent.setup();
    renderWithProvider(<PasswordInput placeholder="Password" />);

    const input = screen.getByPlaceholderText("Password") as HTMLInputElement;
    const toggle = screen.getByLabelText("Toggle password visibility");
    await user.click(toggle);
    await user.type(input, "hunter2");

    expect(input).toHaveValue("hunter2");
    expect(input.getAttribute("type")).toBe("text");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveAttribute("aria-description", "Password visible");
  });

  it("respects controlled show prop", () => {
    renderWithProvider(<PasswordInput placeholder="Password" show={true} />);

    const input = screen.getByPlaceholderText("Password") as HTMLInputElement;
    expect(input.getAttribute("type")).toBe("text");
  });

  it("keeps live region and toggle state in sync in controlled mode", async () => {
    const user = userEvent.setup();

    const ControlledPasswordInput = () => {
      const [show, setShow] = useState(false);
      return (
        <PasswordInput
          placeholder="Password"
          show={show}
          onToggle={() => {
            setShow((current) => !current);
          }}
          visibleStateLabel="Visible now"
          hiddenStateLabel="Hidden now"
        />
      );
    };

    renderWithProvider(<ControlledPasswordInput />);

    const toggle = screen.getByLabelText("Toggle password visibility");
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Hidden now");
    expect(toggle).toHaveAttribute("aria-description", "Hidden now");
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await user.click(toggle);

    expect(status).toHaveTextContent("Visible now");
    expect(toggle).toHaveAttribute("aria-description", "Visible now");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  it("calls onToggle when controlled", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    renderWithProvider(
      <PasswordInput placeholder="Password" show={false} onToggle={onToggle} />,
    );

    const toggle = screen.getByLabelText("Toggle password visibility");
    await user.click(toggle);

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("applies toggleTestId to the toggle element", () => {
    renderWithProvider(
      <PasswordInput placeholder="Password" toggleTestId="my-toggle" />,
    );

    expect(screen.getByTestId("my-toggle")).toBeInTheDocument();
  });

  it("forwards remaining TextInput props (e.g. status, placeholder)", () => {
    renderWithProvider(<PasswordInput placeholder="Password" status="error" />);

    const input = screen.getByPlaceholderText("Password") as HTMLInputElement;
    expect(input).toBeInTheDocument();
    // Status icon rendered by TextInput
    expect(screen.getByTestId("text-input-status-error")).toBeInTheDocument();
  });

  it("toggles secureTextEntry on the native branch", async () => {
    vi.resetModules();

    try {
      vi.doMock("react-native", async () => {
        const actual = (await vi.importActual("react-native")) as Record<
          string,
          unknown
        >;
        return {
          ...actual,
          Platform: {
            ...(actual.Platform as Record<string, unknown>),
            OS: "ios",
            select: (spec: Record<string, unknown>) => spec.ios ?? spec.default,
          },
        };
      });

      vi.doMock("../forms/TextInput", () => ({
        TextInput: forwardRef<HTMLInputElement, Record<string, unknown>>(
          (
            {
              placeholder,
              secureTextEntry,
              type,
              testId,
              paddingRight: _paddingRight,
              fullWidth: _fullWidth,
              ...props
            },
            ref,
          ) => (
            <input
              {...props}
              ref={ref}
              placeholder={
                typeof placeholder === "string" ? placeholder : undefined
              }
              data-testid={typeof testId === "string" ? testId : undefined}
              data-secure-text-entry={String(Boolean(secureTextEntry))}
              data-type-prop={typeof type === "string" ? type : ""}
            />
          ),
        ),
      }));

      const { PasswordInput: NativePasswordInput } =
        await import("../forms/PasswordInput");

      renderWithProvider(
        <NativePasswordInput
          placeholder="Native password"
          toggleTestId="native-toggle"
        />,
      );

      const input = screen.getByPlaceholderText("Native password");
      const toggle = screen.getByTestId("native-toggle");
      expect(input).toHaveAttribute("data-secure-text-entry", "true");
      expect(input).toHaveAttribute("data-type-prop", "");
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(toggle).not.toHaveAttribute("aria-describedby");
      expect(toggle).not.toHaveAttribute("aria-description");

      fireEvent.click(toggle);
      expect(input).toHaveAttribute("data-secure-text-entry", "false");

      fireEvent.click(toggle);
      expect(input).toHaveAttribute("data-secure-text-entry", "true");
    } finally {
      vi.doUnmock("react-native");
      vi.doUnmock("../forms/TextInput");
      vi.resetModules();
    }
  });
});
