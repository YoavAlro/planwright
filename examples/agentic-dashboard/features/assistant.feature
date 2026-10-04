Feature: Support assistant
  The assistant phrases every answer differently. Factual parts are checked structurally;
  tone is judged by the LLM on every run.

  Background:
    Given I open the assistant

  Scenario: Ask about the backlog
    When I ask the assistant "How many open tickets do we have?"
    Then the assistant replies with a number of open tickets
    And the reply sounds like a helpful support teammate

  @mutating
  Scenario: Open a ticket from chat
    When I ask the assistant "Please create a ticket about the login page timing out"
    Then the assistant confirms a new ticket number
    When I go to the dashboard
    Then the recent tickets table shows "login page timing out"
