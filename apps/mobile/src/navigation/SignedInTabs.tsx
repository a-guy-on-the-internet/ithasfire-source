import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import {
  Compass,
  Settings as SettingsIcon,
  Ticket,
  User,
} from "lucide-react-native";

import { useColors } from "@th/ui-native";

import { usePushRegistration } from "@/features/notifications/use-push-registration";
import { CheckoutScreen } from "@/screens/CheckoutScreen";
import { DiscoverScreen } from "@/screens/DiscoverScreen";
import { EventDetailScreen } from "@/screens/EventDetailScreen";
import { OrderDetailScreen } from "@/screens/OrderDetailScreen";
import { ProfileScreen } from "@/screens/ProfileScreen";
import { SettingsScreen } from "@/screens/SettingsScreen";
import { TicketQrScreen } from "@/screens/TicketQrScreen";
import { TicketsScreen } from "@/screens/TicketsScreen";
import type {
  DiscoverStackParamList,
  SignedInTabParamList,
  TicketsStackParamList,
} from "./types";

const Tabs = createBottomTabNavigator<SignedInTabParamList>();
const DiscoverStack = createNativeStackNavigator<DiscoverStackParamList>();
const TicketsStack = createNativeStackNavigator<TicketsStackParamList>();

const DiscoverNavigator = () => {
  // Themed inside the component: `useColors()` cannot run at module scope, and
  // the header has to re-render when the theme flips.
  const colors = useColors();
  return (
    <DiscoverStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.color,
        headerTitleStyle: { fontFamily: "Montserrat-SemiBold" },
      }}
    >
      <DiscoverStack.Screen
        name="DiscoverList"
        component={DiscoverScreen}
        options={{ headerShown: false }}
      />
      <DiscoverStack.Screen
        name="EventDetail"
        component={EventDetailScreen}
        options={({ route }) => ({
          title: route.params.title ?? route.params.eventSlug,
        })}
      />
      <DiscoverStack.Screen
        name="Checkout"
        component={CheckoutScreen}
        options={({ route }) => ({
          title: route.params.title ?? "Checkout",
        })}
      />
    </DiscoverStack.Navigator>
  );
};

const TicketsNavigator = () => {
  const colors = useColors();
  return (
    <TicketsStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.color,
        headerTitleStyle: { fontFamily: "Montserrat-SemiBold" },
      }}
    >
      <TicketsStack.Screen
        name="TicketsList"
        component={TicketsScreen}
        options={{ headerShown: false }}
      />
      <TicketsStack.Screen
        name="OrderDetail"
        component={OrderDetailScreen}
        options={({ route }) => ({
          title: route.params.eventName ?? "Order",
        })}
      />
      <TicketsStack.Screen
        name="TicketQr"
        component={TicketQrScreen}
        options={({ route }) => ({
          title: route.params.eventName ?? "Your pass",
        })}
      />
    </TicketsStack.Navigator>
  );
};

/**
 * Bottom tab bar — Swiss-styled chrome.
 *
 * Per the chrome-exemption rule (UI skill `Chrome Exemption` section), the
 * tab bar is a tool affordance, not content. We keep it RECTANGULAR (not
 * pill-shaped) on mobile because (a) the OS tab-bar form factor is already
 * a horizontal strip and (b) hard 2px top border + accent active color
 * reads as deliberate rather than soft. The "soft chrome" allowance for
 * pills/glass applies on web where chrome floats over content.
 */
export const SignedInTabs = () => {
  const colors = useColors();

  // Push-device lifecycle: registers the Expo token once the session is
  // authenticated AND permission was already granted (opt-in lives on the
  // Settings screen), and re-checks on foreground for token rotation.
  // Silent no-op when permission is undetermined/denied — never prompts.
  usePushRegistration();

  return (
    <Tabs.Navigator
      screenOptions={{
        headerShown: false,
        // The active tint paints an 11px LABEL as well as the icon, so it
        // takes `accentText` (AA as copy in both themes) rather than the raw
        // `accent` fill, which is 3.57:1 on Stub's cream canvas.
        tabBarActiveTintColor: colors.accentText,
        tabBarInactiveTintColor: colors.colorMuted,
        tabBarStyle: {
          backgroundColor: colors.background,
          borderTopWidth: 2,
          borderTopColor: colors.borderColor,
        },
        tabBarLabelStyle: {
          fontFamily: "Montserrat-Medium",
          fontSize: 11,
          letterSpacing: 0.5,
        },
      }}
    >
      <Tabs.Screen
        name="Discover"
        component={DiscoverNavigator}
        options={{
          tabBarIcon: ({ color, size }) => (
            <Compass color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="Tickets"
        component={TicketsNavigator}
        options={{
          tabBarIcon: ({ color, size }) => <Ticket color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="Profile"
        component={ProfileScreen}
        options={{
          tabBarIcon: ({ color, size }) => <User color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="Settings"
        component={SettingsScreen}
        options={{
          tabBarIcon: ({ color, size }) => (
            <SettingsIcon color={color} size={size} />
          ),
        }}
      />
    </Tabs.Navigator>
  );
};
