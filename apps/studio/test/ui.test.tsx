import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  Select,
  Skeleton,
  TabPanel,
  Table,
  Tabs,
  riskTone,
  runStatusTone,
} from "../src/ui/index.ts";

describe("Button", () => {
  it("calls onClick", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Kaydet</Button>);
    await userEvent.click(screen.getByRole("button", { name: "Kaydet" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("is inert and marked busy while working", async () => {
    const onClick = vi.fn();
    render(
      <Button busy onClick={onClick}>
        Kaydet
      </Button>,
    );
    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    await userEvent.click(button).catch(() => undefined);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("defaults to type=button so it never submits a form by accident", () => {
    render(<Button>x</Button>);
    expect(screen.getByRole("button")).toHaveAttribute("type", "button");
  });
});

describe("Input", () => {
  it("links label, error and control for assistive tech", () => {
    render(<Input label="Parola" error="Zorunlu alan" />);
    const input = screen.getByLabelText("Parola");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Zorunlu alan");
  });

  it("shows the hint when there is no error", () => {
    render(<Input label="Kullanıcı adı" hint="kurum hesabın" />);
    expect(screen.getByLabelText("Kullanıcı adı")).toHaveAccessibleDescription("kurum hesabın");
  });
});

describe("Select", () => {
  it("renders options and reports changes", async () => {
    const onChange = vi.fn();
    render(
      <Select
        label="Dil"
        value="tr"
        onChange={onChange}
        options={[
          { value: "tr", label: "Türkçe" },
          { value: "en", label: "İngilizce" },
        ]}
      />,
    );
    await userEvent.selectOptions(screen.getByLabelText("Dil"), "en");
    expect(onChange).toHaveBeenCalled();
  });
});

describe("Table", () => {
  const columns = [
    { key: "k", header: "Ticket", cell: (r: { k: string }) => r.k },
  ];

  it("renders rows", () => {
    render(
      <Table
        columns={columns}
        rows={[{ k: "UGURPAY-1" }, { k: "UGURPAY-2" }]}
        rowKey={(r) => r.k}
        emptyLabel="kayıt yok"
      />,
    );
    expect(screen.getByText("UGURPAY-1")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(3); // header + 2
  });

  it("shows the empty label instead of an empty grid", () => {
    render(<Table columns={columns} rows={[]} rowKey={(r) => r.k} emptyLabel="kayıt yok" />);
    expect(screen.getByText("kayıt yok")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows a skeleton while loading", () => {
    render(
      <Table columns={columns} rows={[]} rowKey={(r) => r.k} emptyLabel="kayıt yok" loading />,
    );
    expect(screen.queryByText("kayıt yok")).not.toBeInTheDocument();
  });

  it("activates a row by keyboard, not only by mouse", async () => {
    const onRowClick = vi.fn();
    render(
      <Table
        columns={columns}
        rows={[{ k: "UGURPAY-1" }]}
        rowKey={(r) => r.k}
        emptyLabel="kayıt yok"
        onRowClick={onRowClick}
      />,
    );
    const row = screen.getAllByRole("button")[0];
    row?.focus();
    await userEvent.keyboard("{Enter}");
    expect(onRowClick).toHaveBeenCalledWith({ k: "UGURPAY-1" });
  });
});

describe("Badge tones", () => {
  it("keeps one colour per domain meaning across screens", () => {
    expect(runStatusTone("gate")).toBe("amber");
    expect(runStatusTone("fail")).toBe("red");
    expect(runStatusTone("failed")).toBe("red");
    expect(runStatusTone("done")).toBe("green");
    expect(runStatusTone("completed")).toBe("green");
    expect(riskTone("kritik")).toBe("red");
    expect(riskTone("dusuk")).toBe("green");
  });

  it("renders its label", () => {
    render(<Badge tone="blue">çalışıyor</Badge>);
    expect(screen.getByText("çalışıyor")).toBeInTheDocument();
  });
});

describe("Tabs", () => {
  function Harness() {
    const [active, setActive] = useState("a");
    return (
      <>
        <Tabs
          label="Sekmeler"
          active={active}
          onChange={setActive}
          items={[
            { id: "a", label: "Analiz" },
            { id: "b", label: "Kanıt" },
          ]}
        />
        <TabPanel id="a" active={active}>
          analiz içeriği
        </TabPanel>
        <TabPanel id="b" active={active}>
          kanıt içeriği
        </TabPanel>
      </>
    );
  }

  it("switches panels and tracks aria-selected", async () => {
    render(<Harness />);
    expect(screen.getByText("analiz içeriği")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Kanıt" }));
    expect(screen.getByText("kanıt içeriği")).toBeInTheDocument();
    expect(screen.queryByText("analiz içeriği")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Kanıt" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("Modal", () => {
  it("renders nothing while closed", () => {
    render(
      <Modal open={false} onClose={vi.fn()} title="Onay" closeLabel="Kapat">
        gövde
      </Modal>,
    );
    expect(screen.queryByText("gövde")).not.toBeInTheDocument();
  });

  it("closes from the close affordance", async () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Onay" closeLabel="Kapat">
        gövde
      </Modal>,
    );
    expect(screen.getByText("gövde")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Kapat" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("EmptyState / Skeleton / Card", () => {
  it("shows the empty headline and description", () => {
    render(<EmptyState title="Kayıt yok" description="Henüz akış başlamadı" />);
    expect(screen.getByText("Kayıt yok")).toBeInTheDocument();
    expect(screen.getByText("Henüz akış başlamadı")).toBeInTheDocument();
  });

  it("marks the skeleton busy", () => {
    const { container } = render(<Skeleton rows={2} />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it("renders a card heading and body", () => {
    render(
      <Card title="Dikkat isteyenler" subtitle="son 24 saat">
        içerik
      </Card>,
    );
    expect(screen.getByRole("heading", { name: "Dikkat isteyenler" })).toBeInTheDocument();
    expect(screen.getByText("içerik")).toBeInTheDocument();
  });
});
