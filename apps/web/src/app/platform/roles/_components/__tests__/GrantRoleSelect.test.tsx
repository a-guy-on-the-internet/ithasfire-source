import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@th/ui", () => ({
  StyledSelect: ({
    value,
    options,
    onChange,
    disabled,
    testId,
  }: {
    value: string;
    options: { value: string; label: string }[];
    onChange: (next: string) => void;
    disabled?: boolean;
    testId?: string;
  }) => (
    <select
      data-testid={testId}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  ),
}));

import { GrantRoleSelect } from "../GrantRoleSelect";
import { ALL_HUMAN_ROLES } from "../roles-constants";

describe("GrantRoleSelect", () => {
  it("only lists roles the human doesn't already hold", () => {
    render(<GrantRoleSelect heldRoles={["USER", "ADMIN"]} onGrant={vi.fn()} />);

    const select = screen.getByTestId("grant-role-select");
    const optionValues = Array.from(select.querySelectorAll("option")).map(
      (o) => o.getAttribute("value"),
    );

    expect(optionValues).toContain("+ add role");
    for (const role of ALL_HUMAN_ROLES) {
      if (role === "USER" || role === "ADMIN") {
        expect(optionValues).not.toContain(role);
      } else {
        expect(optionValues).toContain(role);
      }
    }
  });

  it("renders nothing (all roles already granted)", () => {
    render(
      <GrantRoleSelect heldRoles={[...ALL_HUMAN_ROLES]} onGrant={vi.fn()} />,
    );

    expect(screen.queryByTestId("grant-role-select")).not.toBeInTheDocument();
  });

  it("fires onGrant with the selected role and ignores the placeholder", () => {
    const onGrant = vi.fn();
    render(<GrantRoleSelect heldRoles={["USER"]} onGrant={onGrant} />);

    const select = screen.getByTestId("grant-role-select");
    fireEvent.change(select, { target: { value: "+ add role" } });
    expect(onGrant).not.toHaveBeenCalled();

    fireEvent.change(select, { target: { value: "SUPPORT" } });
    expect(onGrant).toHaveBeenCalledWith("SUPPORT");
  });
});
