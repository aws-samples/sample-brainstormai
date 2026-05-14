import { ReactNode, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  AppLayout,
  TopNavigation,
  SideNavigation,
  SideNavigationProps,
} from "@cloudscape-design/components";
import { useAuth } from "../auth/AuthContext";

interface Props {
  children: ReactNode;
  breadcrumbs?: ReactNode;
}

const NAV_ITEMS: SideNavigationProps.Item[] = [
  { type: "link", text: "My Notebooks", href: "/notebooks" },
  { type: "divider" },
  { type: "link", text: "Usage", href: "/usage" },
];

export default function AppShell({ children, breadcrumbs }: Props) {
  const { logout, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(true);

  return (
    <>
      <TopNavigation
        identity={{
          href: "/notebooks",
          title: "",
          logo: { src: "/banner.png", alt: "BrainstormAI" },
        }}
        utilities={[
          {
            type: "menu-dropdown",
            text: user?.email ?? "Account",
            iconName: "user-profile",
            items: [{ id: "signout", text: "Sign out" }],
            onItemClick: () => logout(),
          },
        ]}
      />

      <AppLayout
        toolsHide
        headerVariant="high-contrast"
        navigationOpen={navOpen}
        onNavigationChange={(e) => setNavOpen(e.detail.open)}
        navigation={
          <SideNavigation
            header={{ text: "BrainstormAI", href: "/notebooks" }}
            activeHref={location.pathname}
            items={NAV_ITEMS}
            onFollow={(e) => {
              e.preventDefault();
              navigate(e.detail.href);
            }}
          />
        }
        breadcrumbs={breadcrumbs}
        content={children}
      />
    </>
  );
}
