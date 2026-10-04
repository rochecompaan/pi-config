{
  defaultProfile = "superpowers";
  # Declaration date, not a build-time timestamp.
  updatedAt = "2026-10-04T00:00:00.000Z";

  # Tools and skills outside these suites remain enabled in every preset.
  profiles = {
    superpowers = {
      suites = [ "superpowers" ];
      extraSkills = [
        "codebase-design"
        "improve-codebase-architecture"
        "domain-modeling"
        "wait-what"
      ];
    };
    matt.suites = [ "matt" ];
  };
}
