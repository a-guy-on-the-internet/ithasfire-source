import { screen } from "@testing-library/react";
import { ChevronRight, Star } from "lucide-react";

import { renderWithProvider } from "../../../../../test/utils";
import { ListItem, ListItemGroup } from "../navigation/ListItem";

function WrapperProbe(props: {
  children: React.ReactNode;
  showDivider?: boolean;
  standalone?: boolean;
  testIdBase?: string;
  qaId?: string;
}) {
  return (
    <div
      data-testid="wrapper-probe"
      data-has-show-divider={String(props.showDivider !== undefined)}
      data-has-standalone={String(props.standalone !== undefined)}
      data-has-testid-base={String(props.testIdBase !== undefined)}
      data-has-qa-id={String(props.qaId !== undefined)}
    >
      {props.children}
    </div>
  );
}

describe("ListItem", () => {
  it("renders title and subtitle copy", () => {
    renderWithProvider(<ListItem title="Featured" subtitle="Limited seats" />);

    expect(screen.getByText("Featured")).toBeInTheDocument();
    expect(screen.getByText("Limited seats")).toBeInTheDocument();
  });

  it("omits automation hooks for leading slot when not provided", () => {
    renderWithProvider(<ListItem title="No icon" />);

    expect(screen.queryByTestId("list-item-leading")).not.toBeInTheDocument();
  });

  it("applies automation hooks for trailing accessory", () => {
    renderWithProvider(
      <ListItem
        title="Has chevron"
        trailingAccessory={
          <ChevronRight data-testid="chevron" size={16} strokeWidth={1.5} />
        }
      />,
    );

    expect(screen.getByTestId("list-item-trailing")).toBeInTheDocument();
  });
});

describe("ListItemGroup", () => {
  it("assigns divider metadata to grouped items", () => {
    renderWithProvider(
      <ListItemGroup testIdBase="demo-list">
        <ListItem
          title="First"
          leadingAccessory={<Star size={16} strokeWidth={1.5} />}
        />
        <ListItem title="Second" />
      </ListItemGroup>,
    );

    const first = screen.getByTestId("demo-list-item-1");
    const second = screen.getByTestId("demo-list-item-2");

    expect(first).toHaveAttribute("data-divider", "true");
    expect(second).toHaveAttribute("data-divider", "false");
  });

  it("respects explicit automation identifiers on children", () => {
    renderWithProvider(
      <ListItemGroup>
        <ListItem title="Preset" testIdBase="custom-item" qaId="custom-item" />
        <ListItem title="Default" />
      </ListItemGroup>,
    );

    expect(screen.getByTestId("custom-item")).toBeInTheDocument();
    expect(screen.getByTestId("list-item-group-item-2")).toBeInTheDocument();
  });

  it("does not inject ListItem-only props into wrapped children", () => {
    renderWithProvider(
      <ListItemGroup testIdBase="wrapped-list" qaId="wrapped-list">
        <WrapperProbe>
          <ListItem title="Wrapped" />
        </WrapperProbe>
        <ListItem title="Direct" />
      </ListItemGroup>,
    );

    const wrapper = screen.getByTestId("wrapper-probe");
    const wrappedItem = screen.getByTestId("wrapped-list-item-1");
    const directItem = screen.getByTestId("wrapped-list-item-2");

    expect(wrapper).toHaveAttribute("data-has-show-divider", "false");
    expect(wrapper).toHaveAttribute("data-has-standalone", "false");
    expect(wrapper).toHaveAttribute("data-has-testid-base", "false");
    expect(wrapper).toHaveAttribute("data-has-qa-id", "false");
    expect(wrappedItem).toHaveAttribute("data-divider", "true");
    expect(directItem).toHaveAttribute("data-divider", "false");
  });

  it("does not leak internal props into anchor wrappers", () => {
    renderWithProvider(
      <ListItemGroup testIdBase="anchor-list" qaId="anchor-list">
        <a href="/wrapped" data-testid="wrapped-anchor">
          <ListItem title="Wrapped link" />
        </a>
        <ListItem title="Direct sibling" />
      </ListItemGroup>,
    );

    const anchor = screen.getByTestId("wrapped-anchor");
    const wrappedItem = screen.getByTestId("anchor-list-item-1");
    const directItem = screen.getByTestId("anchor-list-item-2");

    expect(anchor).not.toHaveAttribute("showDivider");
    expect(anchor).not.toHaveAttribute("standalone");
    expect(anchor).not.toHaveAttribute("testIdBase");
    expect(anchor).not.toHaveAttribute("qaId");
    expect(wrappedItem).toHaveAttribute("data-divider", "true");
    expect(directItem).toHaveAttribute("data-divider", "false");
  });
});
