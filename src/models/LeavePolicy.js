module.exports = (sequelize, DataTypes) => {
  const LeavePolicy = sequelize.define(
    'LeavePolicy',
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
      name: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      scope_type: {
        type: DataTypes.ENUM('org', 'branch', 'department', 'employee'),
        defaultValue: 'org',
      },
      scope_id: DataTypes.UUID,
      effective_from: {
        type: DataTypes.DATEONLY,
        allowNull: false,
      },
      effective_to: DataTypes.DATEONLY,
      accrual_frequency: {
        type: DataTypes.ENUM('none', 'monthly', 'quarterly', 'yearly'),
        defaultValue: 'yearly',
      },
      entitlements: {
        type: DataTypes.JSONB,
        defaultValue: {},
      },
      carry_forward: {
        type: DataTypes.JSONB,
        defaultValue: {},
      },
      approval_workflow_id: DataTypes.UUID,
      is_default: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      is_active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
      settings: {
        type: DataTypes.JSONB,
        defaultValue: {},
      },
    },
    {
      tableName: 'leave_policies',
      paranoid: true,
      underscored: true,
      indexes: [
        { fields: ['org_id', 'scope_type', 'scope_id'] },
        { fields: ['org_id', 'is_default'] },
      ],
    }
  );

  LeavePolicy.associate = (models) => {
    LeavePolicy.belongsTo(models.Organisation, { foreignKey: 'org_id', as: 'organisation' });
    LeavePolicy.belongsTo(models.LeaveApprovalWorkflow, {
      foreignKey: 'approval_workflow_id',
      as: 'approvalWorkflow',
    });
  };

  return LeavePolicy;
};
