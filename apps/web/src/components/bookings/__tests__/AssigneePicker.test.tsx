import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The assignee select (booking-holds FR-015): edit-role members only,
 * "Assign to me" when the viewer is one of them and not already assigned,
 * and a former member kept visible rather than silently mis-displayed.
 */

let editors: { humanId: string; name: string | null; email: string | null; role: string }[] = [];
let rosterError = false;
let me: string | null = "me-1";

vi.mock("../useOrgMembers", () => ({
  useOrgMembers: () => ({
    editors,
    labelOf: (id: string) => editors.find((m) => m.humanId === id)?.name ?? null,
    isLoading: false,
    isError: rosterError,
  }),
}));

vi.mock("@/hooks/useEventOwnerEntities", () => ({
  useEventOwnerEntities: () => ({
    ownersWithSlugs: me ? [{ kind: "human", humanId: me }] : [],
  }),
}));

vi.mock("tamagui", () => {
  const Stack = (props: Record<string, unknown>) => (
    <div data-testid={(props.testID ?? props["data-testid"]) as string | undefined}>
      {props.children as ReactNode}
    </div>
  );
  return { XStack: Stack, YStack: Stack };
});

vi.mock("@th/ui", () => ({
  Button: ({
    children,
    disabled,
    onPress,
    testID,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onPress?: () => void;
    testID?: string;
  }) => (
    <button type="button" data-testid={testID} disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
  Spinner: () => <span data-testid="spinner" />,
  StyledSelect: ({
    value,
    options,
    onChange,
    disabled,
    testId,
    selectId,
  }: {
    value: string;
    options: { value: string; label: string }[];
    onChange: (v: string) => void;
    disabled?: boolean;
    testId?: string;
    selectId?: string;
  }) => (
    <select
      id={selectId}
      data-testid={testId}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.currentTarget.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
  Text: ({ children, role }: { children?: ReactNode; role?: string }) => <span role={role}>{children}</span>,
  useTranslations: () => (key: string) => key,
}));

vi.mock("lucide-react", () => ({ UserCheck: () => <span /> }));

import { AssigneePicker } from "../AssigneePicker";

const options = () =>
  Array.from((screen.getByTestId("ap-select") as HTMLSelectElement).options).map((o) => [o.value, o.text]);

beforeEach(() => {
  editors = [
    { humanId: "me-1", name: "Me", email: null, role: "ADMIN" },
    { humanId: "ed-2", name: null, email: "dana@example.com", role: "EDITOR" },
  ];
  rosterError = false;
  me = "me-1";
});

describe("AssigneePicker", () => {
  it("lists Unassigned, then the edit-role roster (name, else email)", () => {
    render(<AssigneePicker orgId="org-1" value={null} onChange={vi.fn()} testIdBase="ap" />);
    expect(options()).toEqual([
      ["__unassigned__", "admin.bkAssigneeUnassigned"],
      ["me-1", "Me"],
      ["ed-2", "dana@example.com"],
    ]);
  });

  it("maps the select to ids and Unassigned to null", () => {
    const onChange = vi.fn();
    render(<AssigneePicker orgId="org-1" value="me-1" onChange={onChange} testIdBase="ap" />);
    fireEvent.change(screen.getByTestId("ap-select"), { target: { value: "ed-2" } });
    expect(onChange).toHaveBeenCalledWith("ed-2");
    fireEvent.change(screen.getByTestId("ap-select"), { target: { value: "__unassigned__" } });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("offers Assign to me only when the viewer holds an edit role and is not already assigned", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <AssigneePicker orgId="org-1" value={null} onChange={onChange} testIdBase="ap" />,
    );
    fireEvent.click(screen.getByTestId("ap-me"));
    expect(onChange).toHaveBeenCalledWith("me-1");
    rerender(<AssigneePicker orgId="org-1" value="me-1" onChange={onChange} testIdBase="ap" />);
    expect(screen.queryByTestId("ap-me")).toBeNull();
    editors = editors.filter((m) => m.humanId !== "me-1");
    rerender(<AssigneePicker orgId="org-1" value={null} onChange={onChange} testIdBase="ap" />);
    expect(screen.queryByTestId("ap-me")).toBeNull();
  });

  it("keeps a FORMER member visible as the current value rather than showing the wrong one", () => {
    render(<AssigneePicker orgId="org-1" value="gone-9" onChange={vi.fn()} testIdBase="ap" />);
    const select = screen.getByTestId("ap-select") as HTMLSelectElement;
    expect(select.value).toBe("gone-9");
    expect(options()).toContainEqual(["gone-9", "admin.bkAssigneeFormerMember"]);
  });

  it("locks the control while a write is in flight, and on a roster error", () => {
    const { rerender } = render(
      <AssigneePicker orgId="org-1" value={null} onChange={vi.fn()} isPending testIdBase="ap" />,
    );
    expect(screen.getByTestId("ap-select")).toBeDisabled();
    expect(screen.getByTestId("spinner")).toBeTruthy();
    expect(screen.queryByTestId("ap-me")).toBeNull();
    rosterError = true;
    rerender(<AssigneePicker orgId="org-1" value={null} onChange={vi.fn()} testIdBase="ap" />);
    expect(screen.getByTestId("ap-select")).toBeDisabled();
    expect(screen.getByRole("alert").textContent).toBe("admin.bkAssigneeRosterError");
  });
});
