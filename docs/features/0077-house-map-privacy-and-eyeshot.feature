Feature: 0077 — House map, privacy & eyeshot
  The house has a recent-BB floor plan and three separate relations over it: a movement graph
  (doors), a sightline graph (what you can see — narrower than adjacency, opaque through closed
  doors), and an earshot graph (what you can rarely, partially overhear — muffled by doors,
  subdivided by zones in big rooms). Who is behind a closed door is not a free ambient read: it is
  acquired knowledge with a pathway, and two houseguests alone in a private room too long becomes an
  observable tell — without ever leaking what they said.

  # Role-only (testing rule): the-player, two-houseguests, a tracker, a private-room, the backyard.

  Background:
    Given a started season on the recent-BB floor plan

  Rule: The floor plan matches the owner's layout

    Scenario: The bathroom does not connect to any bedroom
      Then the bathroom is not adjacent to any bedroom
      And the bathroom is reachable through the living room

    Scenario: The house has a public core and a private wing, and is fully connected
      Then the kitchen, living room, dining room, and backyard are mutually in sightline
      And every room is reachable from every other room
      And the diary room adjoins only the living room and cannot be overheard

  Rule: Eyeshot is gated by sightline, never by raw adjacency

    Scenario: Standing next to a closed bedroom reveals nothing about who is inside
      Given two houseguests are alone in a private bedroom
      And the player walks into the room adjacent to that bedroom
      Then the player does not learn who is in the bedroom
      And the bedroom's occupants do not appear in the player's visible occupants

    Scenario: The open-plan core is seen across freely
      Given houseguests are spread across the kitchen, dining room, and backyard
      When the player stands in the living room
      Then the player sees the occupants of the kitchen, dining room, and backyard
      And the player sees who is loitering in the hallway

  Rule: Who is behind a closed door must be tracked, and can go stale

    Scenario: A witnessed movement becomes a tracked belief
      Given the player sees two houseguests head down the hallway into a bedroom
      Then the player holds a tracked belief that those two are in that bedroom
      And that belief carries a pathway and a confidence

    Scenario: A tracked belief is not the live map — it can go stale
      Given the player tracked two houseguests into a private room
      When one of them slips out unseen
      Then the player still believes both are inside until a new pathway corrects it

    Scenario: Without any pathway, a private room is simply unknown
      Given two houseguests are alone in a private room
      And no one has observed them enter
      Then the player has no knowledge of who is in that room

  Rule: A big room holds multiple groups — eyeshot room-wide, earshot by zone

    Scenario: Two groups in the backyard converse out of earshot but in plain sight
      Given one group talks by the pool and another at the workout corner of the backyard
      Then neither group can overhear the other
      And each group can see that the other group is gathered across the yard

  Rule: Two alone too long is a tell — without leaking the content

    Scenario: A long private one-on-one surfaces as conspicuousness, not content
      Given the player tracked two houseguests into a private room together
      And they have remained there alone for a while
      Then the player receives a read that those two have been holed up together
      And that read names who and where and how long, never what was said
      And the houseguests' actual conversation never reaches the player

    Scenario: The suspicion of a private meeting diffuses to other houseguests
      Given a third houseguest witnessed the pair slip away together
      Then that observation can diffuse to other houseguests as suspicion
      And no one learns the content of the private scene

  Rule: Privacy is scarce in the public core (the early-game crunch)

    Scenario: A one-on-one in the public core is never private
      Given the player pulls a houseguest aside in the kitchen
      And other houseguests are present in the open-plan core
      Then those houseguests can see the one-on-one is happening
