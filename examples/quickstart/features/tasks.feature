Feature: Task board
  Scenario: Add a task
    Given I am on the task board
    When I add a task named "Buy milk"
    Then I see the task "Buy milk" in the list
    And the open tasks counter is shown
