export interface RoutePlan {
  targets: string[];
}

export type RouteResult =
  | { ok: true; plan: RoutePlan }
  | { ok: false; unknown: string[] };
