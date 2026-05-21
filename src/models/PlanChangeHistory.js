module.exports = (sequelize, DataTypes) => {
  const PlanChangeHistory = sequelize.define(
    'PlanChangeHistory',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      org_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      old_plan: DataTypes.STRING,
      new_plan: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      old_plan_definition_id: DataTypes.UUID,
      new_plan_definition_id: DataTypes.UUID,
      actor_id: DataTypes.UUID,
      reason: DataTypes.TEXT,
      effective_at: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      metadata: {
        type: DataTypes.JSONB,
        defaultValue: {},
      },
    },
    {
      tableName: 'plan_change_history',
      underscored: true,
      indexes: [
        { fields: ['org_id', 'created_at'] },
        { fields: ['new_plan'] },
      ],
    }
  );

  PlanChangeHistory.associate = (models) => {
    PlanChangeHistory.belongsTo(models.Organisation, { foreignKey: 'org_id', as: 'organisation' });
    PlanChangeHistory.belongsTo(models.Employee, { foreignKey: 'actor_id', as: 'actor' });
    PlanChangeHistory.belongsTo(models.PlanDefinition, {
      foreignKey: 'old_plan_definition_id',
      as: 'oldPlanDefinition',
    });
    PlanChangeHistory.belongsTo(models.PlanDefinition, {
      foreignKey: 'new_plan_definition_id',
      as: 'newPlanDefinition',
    });
  };

  return PlanChangeHistory;
};
